/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual } from 'node:util'
import { filledAccentReliability } from './literature-pdf-filled-accent-conflicts.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { classifyTableRuleEdge, clusterTableRulePositions } from './literature-pdf-table-rules.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { rotatedTextRect, tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeSignedScriptRowConflicts } from './literature-pdf-native-script-row-conflicts.mjs'
import { nativeRowspanPrintedDividerConflicts } from './literature-pdf-native-rowspan-conflicts.mjs'
import { nativeScientificOrderReliability } from './literature-pdf-native-scientific-order-conflicts.mjs'
// Prove contradictions against native owners and printed dividers. These checks
// deliberately do not propose a replacement grid or synthesize source ranges.
const compact = (s) => s.replace(/\s/gu, '')
const key = (o) => `${o.pageNumber}:${o.index}`
const rect = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
const same = (a, b) => rect(a) && rect(b) && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
const bounds = (fonts) => [
  Math.min(...fonts.map((f) => f.rect[0])),
  Math.min(...fonts.map((f) => f.rect[1])),
  Math.max(...fonts.map((f) => f.rect[2])),
  Math.max(...fonts.map((f) => f.rect[3]))
]

// Require complete whole native cells, then publish only the proved math witnesses.
// A warning about some other row/column relation is not a mathematical claim.
export function nativeTableUnreliableMathSourceItems(table, inventory, rules = [], context) {
  const page = table.page ?? context?.sourcePage?.pageNumber
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !rect(table.cropRect) ||
    table.parts ||
    table.cropRects ||
    !Array.isArray(table.cells) ||
    !Array.isArray(inventory)
  )
    return []
  const native = new Map(),
    counts = new Map()
  for (const f of inventory) {
    if (!canonicalNativeFont(f)) continue
    const k = key(f.sourceItem)
    native.set(k, native.has(k) ? undefined : f)
  }
  for (const c of table.cells)
    for (const o of [...(c.sourceItems ?? []), ...(c.sourceSegments ?? [])])
      counts.set(key(o), (counts.get(key(o)) ?? 0) + 1)
  const owned = table.cells.flatMap((cell) => {
    if (
      cell.sourceSegments?.length ||
      !cell.sourceItems?.length ||
      cell.sourceRects?.length !== cell.sourceItems.length
    )
      return []
    const fonts = cell.sourceItems.map((o) => native.get(key(o)))
    if (
      fonts.some(
        (f, i) =>
          !f ||
          f.sourceItem.pageNumber !== page ||
          f.text !== cell.sourceItems[i].text ||
          counts.get(key(f.sourceItem)) !== 1 ||
          !Number.isFinite(f.height) ||
          !same(f.rect, cell.sourceRects[i]) ||
          f.rect[2] <= f.rect[0] ||
          f.rect[3] <= f.rect[1] ||
          f.rect.some((n, axis) => (axis < 2 ? n < table.cropRect[axis] : n > table.cropRect[axis]))
      )
    )
      return []
    return [{ cell, fonts, box: bounds(fonts) }]
  })
  const items = [
    ...nativeMathematicalMarkEvidence(owned, inventory, rules, context).sources,
    ...filledAccentReliability(table, inventory, rules, context).sources,
    ...nativeScientificOrderReliability(table, inventory, rules, context).sources
  ].sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
  return items.length <= 8192
    ? items.map(({ pageNumber, index, text }) => ({ pageNumber, index, text }))
    : []
}

export function nativeTableLayoutConflicts(
  table,
  inventory,
  rules = [],
  measuredRuns = [],
  context
) {
  if (!table?.cells?.length || !table.grid?.length || !rect(table.cropRect)) return []
  const native = new Map(),
    owners = new Map(),
    conflicts = new Set([
      ...filledAccentReliability(table, inventory, rules, context).conflicts,
      ...nativeScientificOrderReliability(table, inventory, rules, context).conflicts
    ])
  for (const f of inventory) {
    if (!f.sourceItem || !rect(f.rect) || !f.horizontal || !(f.height > 0)) continue
    const k = key(f.sourceItem)
    native.set(k, native.has(k) ? undefined : f)
  }
  for (const c of table.cells)
    for (const o of c.sourceItems ?? []) owners.set(key(o), (owners.get(key(o)) ?? 0) + 1)
  const resolved = (cell) => {
    if (cell.sourceSegments?.length || !cell.sourceItems?.length) return undefined
    const fonts = cell.sourceItems.map((o) => native.get(key(o)))
    return fonts.some(
      (f, i) =>
        !f || f.text !== cell.sourceItems[i].text || f.sourceItem.text !== cell.sourceItems[i].text
    )
      ? undefined
      : fonts
  }
  const proved = [],
    owned = []
  for (const cell of table.cells) {
    const fonts = resolved(cell)
    if (!fonts) continue
    if (
      cell.sourceRects?.length === fonts.length &&
      fonts.every(
        (f, i) => same(f.rect, cell.sourceRects[i]) && owners.get(key(f.sourceItem)) === 1
      )
    )
      owned.push({ cell, fonts, box: bounds(fonts) })
    // Large inline operators can have a raised native baseline. Sorting them
    // by top edge must not move them before the complete text on their left.
    // Require exact native ownership and the same character inventory; this
    // says nothing about ordinary superscripts or missing Unicode mappings.
    if (
      cell.sourceRects?.length === fonts.length &&
      fonts.every(
        (f, i) => same(f.rect, cell.sourceRects[i]) && owners.get(key(f.sourceItem)) === 1
      ) &&
      [...compact(cell.text)].sort().join('') ===
        [...compact(fonts.map((f) => f.text).join(''))].sort().join('')
    ) {
      const serialized = cell.sourceTokens?.map((t) =>
        fonts.filter(
          (f) =>
            f.text === t.text &&
            same(f.rect, t.rect) &&
            f.baseline === t.baseline &&
            f.height === t.height
        )
      )
      if (
        serialized?.length === fonts.length &&
        serialized.every((matches) => matches.length === 1) &&
        new Set(serialized.map(([f]) => f)).size === fonts.length &&
        compact(serialized.map(([f]) => f.text).join('')) === compact(cell.text)
      ) {
        const order = serialized.map(([f]) => f)
        for (const script of fonts)
          for (const base of fonts)
            if (
              script.height < base.height * 0.85 &&
              script.height > base.height * 0.5 &&
              script.baseline < base.baseline - base.height * 0.2 &&
              script.baseline > base.rect[1] &&
              script.rect[0] >= base.rect[2] - base.height * 0.05 &&
              script.rect[0] - base.rect[2] < base.height &&
              script.sourceItem.index > base.sourceItem.index &&
              order.indexOf(script) < order.indexOf(base)
            )
              conflicts.add('native-script-precedes-base')
      }
      const first = fonts[0]
      for (const operator of fonts.filter((f) => /^[∫∑∏]$/u.test(f.text)))
        if (
          first !== operator &&
          /\p{L}{2}/u.test(first.text) &&
          cell.text.trimStart().startsWith(operator.text) &&
          first.rect[2] < operator.rect[0] &&
          first.sourceItem.index < operator.sourceItem.index &&
          operator.baseline < first.baseline &&
          operator.baseline > first.rect[1] &&
          Math.abs(operator.height - first.height) < first.height * 0.1 &&
          fonts.some(
            (f) =>
              f.rect[0] > operator.rect[2] &&
              Math.abs(f.baseline - first.baseline) < first.height * 0.1
          )
        )
          conflicts.add('native-inline-operator-order-conflict')
    }
    if (
      compact(fonts.map((f) => f.text).join('')) === compact(cell.text) &&
      cell.sourceRects?.length === fonts.length &&
      fonts.every(
        (f, i) => same(f.rect, cell.sourceRects[i]) && owners.get(key(f.sourceItem)) === 1
      )
    )
      proved.push({ cell, fonts, box: bounds(fonts) })
    // A mixed cell cannot be safely partitioned from parent text alone. Single
    // parent sharing remains valid; measured segment carriers are handled above.
    if (
      fonts.length < 2 ||
      cell.sourceRects?.length !== fonts.length ||
      compact(cell.sourceItems.map((o) => o.text).join('')) === compact(cell.text)
    )
      continue
    for (let i = 0; i < fonts.length; i++) {
      const f = fonts[i],
        r = cell.sourceRects[i]
      if (
        owners.get(key(f.sourceItem)) < 2 ||
        same(r, f.rect) ||
        !rect(r) ||
        fonts.some((g, j) => j !== i && !same(g.rect, cell.sourceRects[j]))
      )
        continue
      if (
        r[0] < f.rect[0] - 1e-6 ||
        r[2] > f.rect[2] + 1e-6 ||
        r[2] <= r[0] ||
        Math.abs(r[1] - f.rect[1]) > 1e-6 ||
        Math.abs(r[3] - f.rect[3]) > 1e-6
      )
        continue
      const prefix = compact(
          fonts
            .slice(0, i)
            .map((f) => f.text)
            .join('')
        ),
        suffix = compact(
          fonts
            .slice(i + 1)
            .map((f) => f.text)
            .join('')
        ),
        value = compact(cell.text),
        parent = compact(f.text)
      let part
      if (
        value.startsWith(prefix) &&
        value.endsWith(suffix) &&
        value.length > prefix.length + suffix.length
      ) {
        part = value.slice(prefix.length, value.length - suffix.length)
      } else {
        // A raised peer may be serialized before its native stream position.
        // Remove only uniquely occurring complete peer literals. This proves
        // an unsafe mixed claim, never a replacement range or reading order.
        part = value
        for (let j = 0; j < fonts.length; j++) {
          if (j === i) continue
          const peer = compact(fonts[j].text),
            start = part.indexOf(peer)
          if (!peer || start < 0 || part.indexOf(peer, start + 1) >= 0) {
            part = ''
            break
          }
          part = part.slice(0, start) + part.slice(start + peer.length)
        }
      }
      const start = parent.indexOf(part)
      if (part && part.length < parent.length && start >= 0 && parent.indexOf(part, start + 1) < 0)
        conflicts.add('unmeasured-mixed-source-partition')
    }
  }
  const leaves = proved.filter((p) => p.cell.colSpan === 1 && p.cell.rowSpan === 1)
  const horizontal = rules.filter((r) => rect(r) && Math.abs(r[1] - r[3]) < 1e-6 && r[2] > r[0])
  const bandOwners = table.cells.flatMap((cell) => {
    const fonts = resolved(cell)
    if (
      !fonts ||
      cell.sourceRects?.length !== fonts.length ||
      fonts.some(
        (f) =>
          owners.get(key(f.sourceItem)) !== 1 ||
          cell.sourceRects.filter((r) => same(r, f.rect)).length !== 1
      ) ||
      [...compact(cell.text)].sort().join('') !==
        [...compact(fonts.map((f) => f.text).join(''))].sort().join('')
    )
      return []
    return [{ cell, fonts, box: bounds(fonts) }]
  })
  for (const conflict of nativeBandConflicts(table, bandOwners, native, owners, rules, horizontal))
    conflicts.add(conflict)
  for (const conflict of nativeRecordContradictions(
    table,
    bandOwners,
    native,
    owners,
    horizontal,
    inventory
  ))
    conflicts.add(conflict)
  // These gates only add the existing conservative warning. Native claims and
  // the proposed grid remain untouched; incomplete evidence cannot repair either.
  const strictNative = new Map(
    [...native].map(([k, f]) => [k, canonicalNativeFont(f) ? f : undefined])
  )
  const strictOwned = owned.filter((p) =>
    p.fonts.every((f) => strictNative.get(key(f.sourceItem)) === f)
  )
  const strictProved = proved.filter((p) =>
    p.fonts.every((f) => strictNative.get(key(f.sourceItem)) === f)
  )
  for (const conflict of [
    ...nativeClosedFaceContradictions(table, strictProved, strictNative, owners, rules),
    ...nativeLabelSourceBlockConflicts(table, strictOwned, strictNative, owners, rules),
    ...nativeHeaderLaneConflicts(table, strictOwned, strictNative, owners, inventory, rules),
    ...nativeRemainingOwnershipConflicts(
      table,
      strictOwned,
      strictNative,
      inventory,
      rules,
      bandOwners.filter((p) => p.fonts.every((f) => strictNative.get(key(f.sourceItem)) === f))
    ),
    ...nativeClosedScalarOrScriptConflicts(
      table,
      bandOwners,
      strictNative,
      inventory,
      rules,
      measuredRuns,
      owners
    ),
    ...nativeSourcePacketConflicts(table, strictOwned, inventory, rules, context, measuredRuns),
    ...(nativeRuledHeaderLanes(table, inventory, rules, context).length
      ? ['native-ruled-header-value-lanes-collapsed']
      : [])
  ])
    conflicts.add(conflict)
  const completeNativeOwners = owned.filter((p) =>
    p.fonts.every(
      (f) =>
        canonicalNativeFont(f) &&
        f.sourceItem.pageNumber === table.page &&
        Number.isFinite(f.height) &&
        f.height > 0 &&
        Number.isFinite(f.baseline) &&
        rect(f.rect)
    )
  )
  for (const conflict of [
    ...nativeMathematicalMarkEvidence(completeNativeOwners, inventory, rules, context).conflicts,
    ...nativeSignedScriptRowConflicts(table, inventory, rules, context),
    ...nativeIndependentRecordConflicts(completeNativeOwners),
    ...nativePrintedGroupConflicts(completeNativeOwners, inventory, rules, context)
  ])
    conflicts.add(conflict)
  const oneLine = (p) =>
    p.fonts.every((f) => Math.abs(f.baseline - p.fonts[0].baseline) < f.height * 0.1)
  const bodyLane = (column, after) =>
    leaves.filter((p) => p.cell.column === column && p.cell.row > after && oneLine(p))
  const stableLane = (column, after) => {
    const lane = bodyLane(column, after)
    return (
      lane.length >= 2 &&
      lane.some((a) =>
        lane.some(
          (b) =>
            a !== b &&
            Math.abs((a.box[0] + a.box[2] - b.box[0] - b.box[2]) / 2) < a.fonts[0].height * 0.3
        )
      )
    )
  }
  for (const p of leaves.filter((p) => p.cell.row === 0 && p.fonts.length === 1))
    for (const empty of table.cells.filter(
      (c) =>
        c.row === 0 &&
        c.column === p.cell.column + 1 &&
        c.colSpan === 1 &&
        !c.text?.trim() &&
        !c.sourceItems?.length &&
        !c.sourceSegments?.length
    )) {
      const lane = (column) =>
        owned.filter(
          (q) =>
            q.cell.column === column &&
            q.cell.row > 0 &&
            q.cell.colSpan === 1 &&
            q.cell.rowSpan === 1
        )
      const own = lane(p.cell.column),
        next = lane(empty.column)
      if (
        new Set(own.map((p) => p.cell.row)).size < 2 ||
        new Set(next.map((p) => p.cell.row)).size < 2
      )
        continue
      const h = p.fonts[0].height,
        ownLeft = Math.min(...own.map((p) => p.box[0])),
        ownRight = Math.max(...own.map((p) => p.box[2])),
        nextLeft = Math.min(...next.map((p) => p.box[0]))
      if (
        Math.abs(p.box[0] - ownLeft) < h * 0.2 &&
        nextLeft > ownRight &&
        p.box[2] > nextLeft + h &&
        horizontal.some(
          (r) =>
            r[0] <= p.box[0] &&
            r[2] >= p.box[2] &&
            r[1] > p.box[3] &&
            r[1] < Math.min(...[...own, ...next].map((p) => p.box[1]))
        )
      )
        conflicts.add('native-leaf-header-crosses-empty-column')
    }
  const assignmentHeads = leaves.filter((p) => p.cell.row === 0 && oneLine(p))
  const assignments = []
  for (const p of assignmentHeads)
    for (const identifier of p.fonts.filter((f) => /^\p{L}$/u.test(f.text)))
      for (const q of assignmentHeads)
        for (const value of q.fonts.filter((f) => /^=\s*[+−-]?\d+(?:\.\d+)?$/u.test(f.text))) {
          const h = identifier.height
          if (
            value.rect[0] > identifier.rect[2] &&
            value.rect[0] - identifier.rect[2] < h * 0.3 &&
            Math.abs(value.baseline - identifier.baseline) < h * 0.1 &&
            Math.abs(value.height - h) < h * 0.1 &&
            value.sourceItem.index > identifier.sourceItem.index &&
            bodyLane(q.cell.column, 0).length >= 2
          )
            assignments.push({ identifier, p, q })
        }
  for (const a of assignments)
    if (
      a.p.cell.column + 1 === a.q.cell.column &&
      assignments.filter((b) => b.identifier.text === a.identifier.text).length >= 3 &&
      assignments.some((b) => b.identifier.text === a.identifier.text && b.p === b.q)
    )
      conflicts.add('native-assignment-header-crosses-column')
  const oriented = inventory.filter(
    (f) =>
      f.sourceItem &&
      f.sourceItem.text === f.text &&
      !f.horizontal &&
      rect(f.rect) &&
      f.height > 0 &&
      Number.isFinite(f.baseline) &&
      table.unassigned?.includes(f.text) &&
      !owners.has(key(f.sourceItem)) &&
      inventory.filter((g) => g.sourceItem && key(g.sourceItem) === key(f.sourceItem)).length === 1
  )
  for (const bottom of horizontal) {
    const headings = oriented.flatMap((f) => {
      if (
        f.rect[0] < bottom[0] - f.height * 0.01 ||
        f.rect[2] > bottom[2] + f.height * 0.01 ||
        f.rect[3] >= bottom[1] ||
        bottom[1] - f.rect[3] > f.height * 2 ||
        !horizontal.some(
          (top) =>
            Math.abs(top[0] - bottom[0]) < 1e-6 &&
            Math.abs(top[2] - bottom[2]) < 0.1 &&
            top[1] < f.rect[1]
        )
      )
        return []
      const columns = [
        ...new Set(
          leaves
            .filter(
              (p) =>
                p.box[1] > bottom[1] &&
                (p.box[0] + p.box[2]) / 2 >= f.rect[0] &&
                (p.box[0] + p.box[2]) / 2 <= f.rect[2]
            )
            .map((p) => p.cell.column)
        )
      ].filter(
        (column) =>
          bodyLane(column, 0).length >= 2 &&
          table.cells.some(
            (c) =>
              c.column === column &&
              c.row === 0 &&
              !c.text?.trim() &&
              !c.sourceItems?.length &&
              !c.sourceSegments?.length
          )
      )
      return columns.length === 1 ? [{ f, column: columns[0] }] : []
    })
    for (const { f } of headings)
      if (
        new Set(
          headings
            .filter((q) => Math.abs(q.f.baseline - f.baseline) < f.height * 0.1)
            .map((q) => q.column)
        ).size >= 3
      )
        conflicts.add('unassigned-oriented-header-band')
  }
  // Separate printed group underlines independently constrain the header above
  // the body columns. A whole native run crossing their gap cannot be a leaf
  // header in just one column. Measured ranges and explicit spans stay exempt.
  for (const p of leaves.filter((p) => p.cell.row < 2 && oneLine(p))) {
    const h = p.fonts[0].height
    for (const a of horizontal)
      for (const b of horizontal) {
        if (
          a[2] >= b[0] ||
          b[0] - a[2] > h * 3 ||
          Math.abs(a[1] - b[1]) > h * 0.1 ||
          p.box[1] < a[1] ||
          p.box[3] - a[1] > h * 2 ||
          p.box[0] >= a[2] - h * 0.2 ||
          p.box[2] <= b[0] + h * 0.2
        )
          continue
        const inGroup = (r) =>
          leaves.some(
            (q) =>
              q.cell.row > p.cell.row &&
              q.box[0] >= r[0] &&
              q.box[2] <= r[2] &&
              stableLane(q.cell.column, p.cell.row)
          )
        if (inGroup(a) && inGroup(b)) conflicts.add('native-header-crosses-printed-groups')
      }
  }
  // A first-row section cannot consume independent native column headings
  // aligned to repeated body fields when no intervening leaf-header row exists.
  for (const p of proved.filter(
    (p) => p.cell.row === 0 && p.cell.colSpan >= 3 && p.fonts.length >= 2 && oneLine(p)
  )) {
    const fonts = [...p.fonts].sort((a, b) => a.rect[0] - b.rect[0]),
      first = fonts[0],
      h = first.height
    const peers = leaves.filter(
      (q) => q.cell.row === 1 && oneLine(q) && stableLane(q.cell.column, 0)
    )
    if (
      peers.length !== p.cell.colSpan ||
      peers.filter((q) => /^\d/u.test(q.cell.text)).length < 2 ||
      fonts.some((f) => Math.abs(f.height - h) > h * 0.1) ||
      fonts[1].rect[0] - first.rect[2] < h * 0.5
    )
      continue
    peers.sort((a, b) => a.cell.column - b.cell.column)
    if (
      Math.abs(first.rect[0] - peers[0].box[0]) < h * 0.2 &&
      first.rect[2] < peers[1].box[0] &&
      Math.abs(fonts[1].rect[0] - peers[1].box[0]) < h * 0.2 &&
      fonts.at(-1).rect[2] > peers.at(-1).box[0] &&
      horizontal.some(
        (r) =>
          r[0] <= p.box[0] &&
          r[2] >= p.box[2] &&
          r[1] > p.box[3] &&
          r[1] < Math.min(...peers.map((q) => q.fonts[0].baseline))
      )
    )
      conflicts.add('native-leaf-header-collapsed-to-section')
  }
  // Repeated closed row faces prove the row unit independently of text line
  // spacing. Only a later face split after complete peer faces is contradictory;
  // an outer frame enclosing an otherwise unruled table is not enough.
  const body = leaves.filter((p) => p.cell.row > 0)
  if (body.length) {
    const box = bounds(body.flatMap((p) => p.fonts)),
      h = Math.min(...body.flatMap((p) => p.fonts.map((f) => f.height)))
    const bars = horizontal
      .filter(
        (r) =>
          r[0] <= box[0] + 1e-6 &&
          r[2] >= box[2] - 1e-6 &&
          r[1] >= table.cropRect[1] &&
          r[1] <= table.cropRect[3]
      )
      .sort((a, b) => a[1] - b[1])
    let peers = 0
    for (let i = 1; i < bars.length; i++) {
      const top = bars[i - 1],
        bottom = bars[i]
      const columns = rules.filter(
        (r) =>
          rect(r) &&
          r[0] === r[2] &&
          Math.abs(r[1] - top[1]) < h * 0.15 &&
          Math.abs(r[3] - bottom[1]) < h * 0.15
      )
      if (columns.length < 4) {
        peers = 0
        continue
      }
      const inFace = body.filter((p) =>
        p.fonts.every((f) => f.baseline > top[1] && f.baseline < bottom[1])
      )
      const rows = [...new Set(inFace.map((p) => p.cell.row))].sort((a, b) => a - b)
      if (rows.length === 1 && inFace.length >= 3) peers++
      else if (
        peers >= 2 &&
        rows.length === 2 &&
        rows[1] === rows[0] + 1 &&
        inFace.some((p) => p.cell.row === rows[0] && p.cell.column === 0) &&
        !inFace.some((p) => p.cell.row === rows[1] && p.cell.column === 0) &&
        inFace.filter((p) => p.cell.row === rows[1]).length >= 2
      )
        conflicts.add('closed-record-face-split-across-rows')
      else peers = 0
    }
  }
  // A native two-line centered stub is not two independent record starts when
  // several complete, column-major native fields span three aligned lines.
  const stubs = body.filter((p) => p.cell.column === 0)
  let centeredGroups = 0
  const groupBars = horizontal
    .filter((r) => r[1] >= table.cropRect[1] && r[1] <= table.cropRect[3])
    .sort((a, b) => a[1] - b[1])
  for (let i = 1; i < groupBars.length; i++) {
    const top = groupBars[i - 1],
      bottom = groupBars[i]
    const inBand = body.filter((p) =>
      p.fonts.every((f) => f.rect[1] > top[1] && f.baseline < bottom[1])
    )
    const labels = inBand.filter((p) => p.cell.column === 0),
      peers = inBand.filter((p) => p.cell.column > 0)
    if (
      labels.length !== 2 ||
      labels.some((p) => p.fonts.length !== 1) ||
      peers.length < 12 ||
      peers.some((p) => !oneLine(p))
    )
      continue
    const rows = [...new Set(peers.map((p) => p.cell.row))].sort((a, b) => a - b),
      columns = [...new Set(peers.map((p) => p.cell.column))],
      [a, b] = labels.sort((a, b) => a.cell.row - b.cell.row),
      h = a.fonts[0].height,
      box = bounds(inBand.flatMap((p) => p.fonts))
    if (
      rows.length !== 4 ||
      columns.length < 3 ||
      rows.some((r, j) => r !== rows[0] + j) ||
      rows.some((row) =>
        columns.some(
          (column) =>
            peers.filter((p) => p.cell.row === row && p.cell.column === column).length !== 1
        )
      ) ||
      a.cell.row !== rows[1] ||
      b.cell.row !== rows[2] ||
      Math.abs(a.box[0] - b.box[0]) > h * 0.1 ||
      a.fonts[0].sourceItem.index + 1 !== b.fonts[0].sourceItem.index ||
      peers.some((p) => p.fonts.some((f) => f.sourceItem.index < b.fonts[0].sourceItem.index)) ||
      [top, bottom].some((r) => r[0] > box[0] + h * 0.01 || r[2] < box[2] - h * 0.01)
    )
      continue
    const first = peers.filter((p) => p.cell.row === rows[0]).map((p) => p.fonts[0].baseline),
      last = peers.filter((p) => p.cell.row === rows[3]).map((p) => p.fonts[0].baseline)
    if (
      Math.max(...first) - Math.min(...first) < h * 0.1 &&
      Math.max(...last) - Math.min(...last) < h * 0.1 &&
      Math.abs(a.fonts[0].baseline + b.fonts[0].baseline - first[0] - last[0]) < h * 0.2
    )
      centeredGroups++
  }
  if (centeredGroups >= 2) conflicts.add('centered-group-stub-split-across-rows')
  if (
    stubs.length === 2 &&
    stubs.every((p) => p.fonts.length === 1) &&
    stubs[0].cell.row === 1 &&
    stubs[1].cell.row === 2
  ) {
    const [a, b] = stubs.map((p) => p.fonts[0]),
      h = a.height,
      step = b.baseline - a.baseline
    const nativeOrder = [...native.values()]
      .filter(Boolean)
      .sort((x, y) => x.sourceItem.index - y.sourceItem.index)
    let columns = 0
    for (const col of new Set(body.map((p) => p.cell.column))) {
      if (col === 0) continue
      const parts = body
        .filter((p) => p.cell.column === col)
        .sort((x, y) => x.cell.row - y.cell.row)
      if (parts.length !== 3 || parts.some((p, i) => p.cell.row !== i + 1 || p.fonts.length !== 1))
        continue
      const ff = parts.map((p) => p.fonts[0]),
        start = nativeOrder.indexOf(ff[0])
      if (
        ff.every(
          (f, i) =>
            nativeOrder[start + i] === f &&
            Math.abs(f.height - h) < h * 0.1 &&
            Math.abs(f.rect[0] - ff[0].rect[0]) < h * 0.2 &&
            Math.abs(f.baseline - ff[0].baseline - i * step) < h * 0.1
        ) &&
        ff[0].sourceItem.index > b.sourceItem.index &&
        Math.abs(a.baseline - ff[0].baseline - step / 2) < h * 0.15
      )
        columns++
    }
    if (
      columns >= 2 &&
      step > h &&
      step < h * 3 &&
      Math.abs(a.rect[0] - b.rect[0]) < h * 0.1 &&
      horizontal.some(
        (r) =>
          r[0] <= a.rect[0] && r[2] >= a.rect[2] && r[1] < a.rect[1] && a.rect[1] - r[1] < h * 2
      )
    )
      conflicts.add('staggered-native-stub-records')
  }
  // Clipped header atoms must be exact native items, located above independent
  // printed column separators with repeated body lanes. Generic crop warnings
  // and unassigned prose are deliberately insufficient to block a good table.
  const clipped = [...native.values()].filter(
    (f) =>
      f &&
      !owners.has(key(f.sourceItem)) &&
      f.rect[1] < table.cropRect[1] &&
      f.rect[3] > table.cropRect[1] &&
      table.clipped?.some((c) => c.text === f.text && same(c.rect, f.rect))
  )
  const headerColumns = new Map()
  for (const p of leaves.filter((p) => p.cell.row === 0 && stableLane(p.cell.column, -1))) {
    const h = p.fonts[0].height
    const r = horizontal.find(
      (r) =>
        r[0] <= p.box[0] &&
        r[2] >= p.box[2] &&
        r[1] < p.fonts[0].baseline &&
        p.fonts[0].baseline - r[1] < h * 1.5 &&
        clipped.some(
          (f) =>
            f.rect[0] >= r[0] && f.rect[2] <= r[2] && f.baseline < r[1] && r[1] - f.baseline < h * 2
        )
    )
    if (r) headerColumns.set(p.cell.column, r[1])
  }
  if (
    headerColumns.size >= 3 &&
    Math.max(...headerColumns.values()) - Math.min(...headerColumns.values()) < 0.1
  )
    conflicts.add('clipped-native-header-band')
  // Repeated leaf names and a complete peer span supply the missing span's
  // independent evidence. A centered heading by itself is insufficient.
  for (const group of proved.filter(
    (p) => p.cell.row === 0 && p.cell.colSpan >= 2 && p.cell.rowSpan === 1
  )) {
    const n = group.cell.colSpan,
      start = group.cell.column
    const children = Array.from({ length: n }, (_, i) =>
      leaves.find((p) => p.cell.row === 1 && p.cell.column === start + i)
    )
    if (children.some((p) => !p) || children.some((p) => p.fonts.length !== 1)) continue
    const h = Math.min(...children.map((p) => p.fonts[0].height)),
      y = children[0].fonts[0].baseline
    if (
      children.some((p) => Math.abs(p.fonts[0].baseline - y) > h * 0.1) ||
      group.box[3] >= y - h * 0.5
    )
      continue
    for (const peer of leaves.filter(
      (p) =>
        p.cell.row === 0 && p.cell.column < start && Math.abs(p.box[3] - group.box[3]) < h * 0.1
    )) {
      for (let first = 0; first + n <= start; first++) {
        if (peer.cell.column < first || peer.cell.column >= first + n) continue
        const other = Array.from({ length: n }, (_, i) =>
          leaves.find((p) => p.cell.row === 1 && p.cell.column === first + i)
        )
        if (
          other.some(
            (p, i) =>
              !p ||
              p.fonts.length !== 1 ||
              compact(p.cell.text) !== compact(children[i].cell.text) ||
              Math.abs(p.fonts[0].baseline - y) > h * 0.1
          )
        )
          continue
        if (
          table.cells.some(
            (c) =>
              c.row === 0 &&
              c !== peer.cell &&
              c.text?.trim() &&
              c.column < first + n &&
              c.column + (c.colSpan ?? 1) > first
          )
        )
          continue
        const left = other[0].box[0],
          right = other.at(-1).box[2],
          center = (peer.box[0] + peer.box[2]) / 2
        if (
          peer.box[0] >= left - h &&
          peer.box[2] <= right + h &&
          Math.abs(center - (left + right) / 2) < h &&
          peer.box[0] < other[peer.cell.column - first].box[0] &&
          peer.box[2] > other[peer.cell.column - first].box[2]
        )
          conflicts.add('inconsistent-grouped-header-span')
      }
    }
  }
  // Native vertical rules recurring through three body records are independent
  // column boundaries. Do not reject an explicitly spanning cell.
  const vertical = rules.filter((r) => rect(r) && Math.abs(r[0] - r[2]) < 1e-6 && r[3] > r[1]),
    cutRows = new Map()
  for (const p of leaves.filter((p) => p.cell.row > 0))
    for (const r of vertical) {
      const left = p.fonts.filter((f) => f.rect[2] < r[0]),
        right = p.fonts.filter((f) => f.rect[0] > r[0])
      if (
        !left.length ||
        !right.length ||
        p.fonts.some((f) => f.rect[0] < r[0] && f.rect[2] > r[0])
      )
        continue
      if (
        !left.some((a) =>
          right.some(
            (b) =>
              Math.abs(a.baseline - b.baseline) < Math.min(a.height, b.height) * 0.1 &&
              a.baseline > r[1] &&
              a.baseline < r[3]
          )
        )
      )
        continue
      const k = `${p.cell.column}:${r[0].toFixed(3)}`
      if (!cutRows.has(k)) cutRows.set(k, new Set())
      cutRows.get(k).add(p.cell.row)
    }
  if ([...cutRows.values()].some((rows) => rows.size >= 3))
    conflicts.add('printed-divider-inside-leaf-column')
  const numericPeers = (row) =>
    leaves.filter(
      (p) =>
        p.cell.row === row &&
        p.cell.column > 0 &&
        p.fonts.length === 1 &&
        /^\d/u.test(p.fonts[0].text.trim())
    )
  const displaced = new Set()
  for (const p of leaves.filter((p) => p.cell.column === 0 && p.cell.row > 1)) {
    const prev = leaves.find((q) => q.cell.column === 0 && q.cell.row === p.cell.row - 1),
      peers = numericPeers(p.cell.row)
    if (!prev || peers.length < 2) continue
    const y = peers[0].fonts[0].baseline,
      h = peers[0].fonts[0].height
    if (
      peers.some((q) => Math.abs(q.fonts[0].baseline - y) > h * 0.1) ||
      !p.fonts.some((f) => Math.abs(f.baseline - y) < h * 0.1)
    )
      continue
    const before = p.fonts.filter((f) => f.baseline < y - h && Math.abs(f.height - h) < h * 0.1)
    const old = [...prev.fonts].sort((a, b) => a.baseline - b.baseline),
      last = old.at(-1),
      penultimate = old.at(-2)
    if (before.length !== 1 || !last || !penultimate) continue
    const tail = before[0],
      step = last.baseline - penultimate.baseline,
      previousPeers = numericPeers(p.cell.row - 1),
      currentStart = p.fonts.find((f) => Math.abs(f.baseline - y) < h * 0.1)
    // Native stream order places this tail before the previous record's
    // numbers, while the new label starts after those same numbers. This
    // rejects merely centered multiline labels with similar line spacing.
    if (
      previousPeers.length < 2 ||
      previousPeers.some(
        (q) =>
          q.fonts[0].sourceItem.index <= tail.sourceItem.index ||
          q.fonts[0].sourceItem.index >= currentStart.sourceItem.index
      )
    )
      continue
    if (
      step > h &&
      step < h * 1.5 &&
      Math.abs(tail.baseline - last.baseline - step) < h * 0.1 &&
      Math.abs(tail.rect[0] - last.rect[0]) < h * 0.1 &&
      tail.sourceItem.index === last.sourceItem.index + 1 &&
      tail.sourceItem.pageNumber === last.sourceItem.pageNumber
    )
      displaced.add(p.cell.row)
  }
  if (displaced.size >= 1) conflicts.add('stub-continuation-crosses-record-row')
  for (const r of horizontal) {
    const first = leaves.filter((p) => p.cell.row === 0),
      all = first.flatMap((p) => p.fonts)
    if (
      first.length >= 3 &&
      all.length &&
      r[0] <= Math.min(...all.map((f) => f.rect[0])) &&
      r[2] >= Math.max(...all.map((f) => f.rect[2])) &&
      first.every(
        (p) =>
          p.fonts.some((f) => f.baseline < r[1]) &&
          p.fonts.some((f) => f.rect[1] > r[1] || verifiedNativeLabelRect(f)?.[1] > r[1])
      )
    )
      conflicts.add('printed-header-rule-inside-row')
    for (const p of leaves)
      for (const a of p.fonts) {
        if (
          !/^[\p{L}\p{N}]+$/u.test(a.text.trim()) ||
          a.baseline >= r[1] ||
          r[1] - a.baseline > a.height * 0.5 ||
          r[2] - r[0] > a.height * 1.5 ||
          a.rect[0] < r[0] - a.height * 0.1 ||
          a.rect[2] > r[2] + a.height * 0.1
        )
          continue
        const next = leaves.find(
          (q) => q.cell.row === p.cell.row + 1 && q.cell.column === p.cell.column
        )
        if (!next) continue
        for (const b of next.fonts) {
          if (
            !/^\d+$/u.test(b.text.trim()) ||
            b.baseline <= r[1] ||
            b.baseline - a.baseline > a.height * 2 ||
            Math.abs(a.height - b.height) > a.height * 0.1 ||
            b.rect[0] < r[0] - a.height * 0.1 ||
            b.rect[2] > r[2] + a.height * 0.1
          )
            continue
          const peers = leaves.filter(
            (q) => q.cell.row === next.cell.row && q.cell.column !== next.cell.column
          )
          if (
            peers.length >= 2 &&
            peers.every((q) => q.fonts.every((f) => f.baseline > b.baseline + b.height)) &&
            next.fonts.some((f) => f !== b && f.baseline > b.baseline + b.height)
          )
            conflicts.add('fraction-crosses-record-row')
        }
      }
  }
  // A record's native stream starts with its stub, then a multi-line field,
  // then independently aligned numeric columns. A prefix drawn after that
  // stub cannot belong to the preceding grid row even when their boxes touch.
  const numericLine = (p) =>
    /^[+−-]?\d/u.test(p.cell.text.trim()) &&
    p.fonts.every((f) => Math.abs(f.baseline - p.fonts[0].baseline) < f.height * 0.1)
  for (const p of leaves.filter((p) => p.cell.column > 0 && p.cell.row > 0)) {
    const next = leaves.find(
        (q) => q.cell.row === p.cell.row + 1 && q.cell.column === p.cell.column
      ),
      stub = leaves.find((q) => q.cell.row === p.cell.row + 1 && q.cell.column === 0),
      peers = leaves.filter(
        (q) => q.cell.row === p.cell.row && q.cell.column > p.cell.column && numericLine(q)
      ),
      nextPeers = leaves.filter(
        (q) => q.cell.row === p.cell.row + 1 && q.cell.column > p.cell.column && numericLine(q)
      )
    if (!next || !stub || stub.fonts.length !== 1 || peers.length < 2 || nextPeers.length < 2)
      continue
    const anchor = stub.fonts[0],
      h = anchor.height,
      y = anchor.baseline,
      oldY = peers[0].fonts[0].baseline
    if (
      peers.some((q) => q.fonts.some((f) => Math.abs(f.baseline - oldY) > h * 0.1)) ||
      nextPeers.some((q) => q.fonts.some((f) => Math.abs(f.baseline - y) > h * 0.1)) ||
      !next.fonts.some((f) => Math.abs(f.baseline - y) < h * 0.1)
    )
      continue
    for (const f of p.fonts)
      if (
        f.baseline > oldY + h &&
        f.baseline < y - h * 0.5 &&
        y - f.baseline < h * 1.2 &&
        Math.abs(f.height - h) < h * 0.1 &&
        f.rect[0] >= next.box[0] - h &&
        f.rect[2] <= next.box[2] + h &&
        f.sourceItem.index === anchor.sourceItem.index + 1 &&
        peers.every((q) => q.fonts.every((g) => g.sourceItem.index < anchor.sourceItem.index)) &&
        next.fonts.every((g) => g.sourceItem.index > f.sourceItem.index) &&
        nextPeers.every((q) => q.fonts.every((g) => g.sourceItem.index > f.sourceItem.index))
      )
        conflicts.add('native-record-prefix-crosses-row')
  }
  const unowned = [...native.values()].filter(
    (f) =>
      f &&
      !owners.has(key(f.sourceItem)) &&
      table.unassigned?.includes(f.text) &&
      f.sourceItem.text === f.text &&
      f.rect[0] >= table.cropRect[0] &&
      f.rect[1] >= table.cropRect[1] &&
      f.rect[2] <= table.cropRect[2] &&
      f.rect[3] <= table.cropRect[3]
  )
  const missingTails = []
  for (const f of unowned.filter((f) => /\p{L}{2}/u.test(f.text))) {
    for (const p of owned.filter((p) => p.cell.colSpan === 1 && p.cell.rowSpan === 1)) {
      const tail = p.fonts.reduce((a, b) => (a.baseline > b.baseline ? a : b)),
        h = f.height
      if (
        f.baseline <= tail.baseline ||
        f.baseline - tail.baseline > h * 2 ||
        Math.abs(f.rect[0] - p.box[0]) > h * 0.1 ||
        f.rect[2] > p.box[2] + h * 0.1 ||
        Math.abs(tail.height - h) > h * 0.1
      )
        continue
      const next = owned.find(
        (q) =>
          q.cell.column === p.cell.column &&
          q.cell.row === p.cell.row + 1 &&
          q.cell.colSpan === 1 &&
          q.cell.rowSpan === 1
      )
      if (!next) continue
      const fullSize = next.fonts.filter((g) => Math.abs(g.height - h) < h * 0.1)
      if (!fullSize.length) continue
      const first = fullSize.reduce((a, b) => (a.baseline < b.baseline ? a : b)),
        firstLeft = Math.min(
          ...fullSize
            .filter((g) => Math.abs(g.baseline - first.baseline) < h * 0.1)
            .map((g) => g.rect[0])
        )
      if (
        first.baseline > f.baseline &&
        Math.abs(first.baseline - f.baseline - (f.baseline - tail.baseline)) < h * 0.1 &&
        Math.abs(firstLeft - f.rect[0]) < h * 0.1 &&
        Math.abs(first.height - h) < h * 0.1
      )
        missingTails.push({ p, f })
    }
  }
  for (const { p, f } of missingTails)
    if (
      new Set(
        missingTails
          .filter(
            (q) =>
              q.p.cell.row === p.cell.row && Math.abs(q.f.baseline - f.baseline) < f.height * 0.1
          )
          .map((q) => q.p.cell.column)
      ).size >= 2
    )
      conflicts.add('unassigned-interior-record-continuations')
  const point = /^[+−-]?\d+(?:\.\d+)?$/u,
    interval = /^\[\s*[+−-]?\d+(?:\.\d+)?\s*,\s*[+−-]?\d+(?:\.\d+)?\s*\]$/u
  const missingEstimates = []
  for (const p of leaves.filter((p) => p.fonts.length === 1 && interval.test(p.cell.text))) {
    const range = p.fonts[0]
    const candidates = unowned.filter(
      (f) =>
        point.test(f.text) &&
        f.baseline < range.baseline &&
        range.baseline - f.baseline < f.height * 2 &&
        Math.abs(f.rect[0] + f.rect[2] - range.rect[0] - range.rect[2]) < f.height * 0.2 &&
        f.rect[0] >= range.rect[0] &&
        f.rect[2] <= range.rect[2]
    )
    if (candidates.length !== 1) continue
    const f = candidates[0]
    const peer = leaves.some(
      (q) =>
        q.cell.column === p.cell.column &&
        q.cell.row !== p.cell.row &&
        q.fonts.some((g) => interval.test(g.text)) &&
        q.fonts.some(
          (g) =>
            point.test(g.text) &&
            Math.abs(g.rect[0] + g.rect[2] - f.rect[0] - f.rect[2]) < f.height * 0.2 &&
            q.fonts.some(
              (range) =>
                interval.test(range.text) &&
                range.baseline > g.baseline &&
                range.baseline - g.baseline < g.height * 2
            )
        )
    )
    if (peer) missingEstimates.push({ p, f })
  }
  for (const { p, f } of missingEstimates)
    if (
      new Set(
        missingEstimates
          .filter(
            (q) =>
              q.p.cell.row === p.cell.row && Math.abs(q.f.baseline - f.baseline) < f.height * 0.1
          )
          .map((q) => q.p.cell.column)
      ).size >= 3
    )
      conflicts.add('unassigned-point-estimate-above-interval')
  // A short left header may be narrower than its record labels. Independent
  // full-width rules enclose the header band; repeated left-aligned native
  // records and two owned peer headings distinguish it from nearby prose.
  for (const f of unowned.filter((f) => /\p{L}/u.test(f.text))) {
    const lane = leaves.filter(
      (p) =>
        p.cell.column === 0 &&
        p.cell.row > 0 &&
        p.box[1] > f.rect[3] &&
        Math.abs(p.box[0] - f.rect[0]) < f.height * 0.2
    )
    if (new Set(lane.map((p) => p.cell.row)).size < 2) continue
    const right = Math.max(...leaves.map((p) => p.box[2]))
    const top = horizontal.filter(
      (r) =>
        r[0] <= f.rect[0] &&
        r[2] >= right - f.height * 0.01 &&
        r[1] < f.rect[1] &&
        f.rect[1] - r[1] < f.height * 3
    )
    for (const rule of horizontal.filter(
      (r) =>
        r[0] <= f.rect[0] &&
        r[2] >= right - f.height * 0.01 &&
        r[1] > f.rect[3] &&
        r[1] < Math.min(...lane.map((p) => p.box[1]))
    )) {
      const peers = leaves.filter(
        (p) => p.cell.column > 0 && p.box[3] < rule[1] && top.some((r) => p.box[1] > r[1])
      )
      if (
        top.length &&
        new Set(peers.map((p) => p.cell.column)).size >= 2 &&
        table.cells.some(
          (c) =>
            c.column === 0 &&
            c.row < Math.min(...lane.map((p) => p.cell.row)) &&
            !c.text?.trim() &&
            !c.sourceItems?.length &&
            !c.sourceSegments?.length
        )
      )
        conflicts.add('unassigned-ruled-leaf-header')
    }
  }
  // An interior record can be wholly absent from the grid. Prove each numeric
  // lane against independently owned records above and below, using the same
  // left, centre or right alignment at both ends. Unassigned notes alone do not
  // establish a record, and measured/shared source carriers cannot anchor it.
  const numericText = (text) => /^[+−-]?\d[\d.,()%+\s−-]*$/u.test(text.trim()),
    alignments = (r) => [r[0], (r[0] + r[2]) / 2, r[2]],
    alignedBetween = (f, a, b) =>
      alignments(f.rect).some(
        (x, i) =>
          Math.abs(x - alignments(a)[i]) < f.height * 0.2 &&
          Math.abs(x - alignments(b)[i]) < f.height * 0.2
      ),
    numericLeaves = leaves.filter((p) => numericLine(p) && numericText(p.cell.text))
  for (const stub of unowned.filter((f) => /\p{L}/u.test(f.text))) {
    const h = stub.height,
      fields = unowned.filter(
        (f) =>
          numericText(f.text) &&
          f.sourceItem.pageNumber === stub.sourceItem.pageNumber &&
          f.sourceItem.index > stub.sourceItem.index &&
          f.rect[0] > stub.rect[2] &&
          Math.abs(f.baseline - stub.baseline) < h * 0.1 &&
          Math.abs(f.height - h) < h * 0.1
      )
    if (fields.length < 3) continue
    const anchors = []
    for (const row of new Set(numericLeaves.map((p) => p.cell.row))) {
      const peers = numericLeaves.filter((p) => p.cell.row === row),
        label = proved
          .filter((p) => p.cell.row === row)
          .flatMap((p) => p.fonts)
          .find(
            (f) =>
              /\p{L}/u.test(f.text) &&
              f.rect[2] < Math.min(...fields.map((g) => g.rect[0])) &&
              Math.abs(f.rect[0] - stub.rect[0]) < h * 0.2 &&
              Math.abs(f.height - h) < h * 0.1
          )
      if (!label || Math.abs(label.baseline - stub.baseline) <= h) continue
      const matches = fields.map((f) =>
        peers.filter(
          (p) =>
            p.fonts.every(
              (g) =>
                Math.abs(g.baseline - label.baseline) < h * 0.1 &&
                Math.abs(g.height - h) < h * 0.1 &&
                g.sourceItem.pageNumber === stub.sourceItem.pageNumber &&
                (label.baseline < stub.baseline
                  ? g.sourceItem.index < stub.sourceItem.index
                  : g.sourceItem.index > f.sourceItem.index)
            ) && alignedBetween(f, p.box, p.box)
        )
      )
      if (
        matches.every((ps) => ps.length === 1) &&
        new Set(matches.map(([p]) => p.cell.column)).size === fields.length
      )
        anchors.push({ label, fields: matches.map(([p]) => p) })
    }
    for (const above of anchors.filter((a) => a.label.baseline < stub.baseline))
      for (const below of anchors.filter((a) => a.label.baseline > stub.baseline))
        if (
          fields.every(
            (f, i) =>
              above.fields[i].cell.column === below.fields[i].cell.column &&
              alignedBetween(f, above.fields[i].box, below.fields[i].box)
          )
        )
          conflicts.add('unassigned-interior-numeric-record')
  }
  const firstRow = leaves.filter((p) => p.cell.row === 0)
  for (const p of firstRow)
    for (const tail of p.fonts)
      for (const f of unowned)
        if (
          firstRow.length >= 3 &&
          /^\([^\p{L}\p{N}]+\)$/u.test(tail.text) &&
          /\p{L}{2}/u.test(f.text) &&
          Math.abs(f.baseline - tail.baseline) < f.height * 0.1 &&
          Math.abs(f.height - tail.height) < f.height * 0.1 &&
          tail.rect[0] - f.rect[2] >= 0 &&
          tail.rect[0] - f.rect[2] < f.height * 0.3 &&
          tail.sourceItem.index > f.sourceItem.index &&
          tail.sourceItem.index - f.sourceItem.index <= 2 &&
          !inventory.some(
            (g) =>
              g.sourceItem?.index > f.sourceItem.index &&
              g.sourceItem.index < tail.sourceItem.index &&
              g.text.trim()
          )
        )
          conflicts.add('unassigned-contiguous-header')
  // A lone raised atom and its immediately following touching native text
  // form one header, not two grid rows. Other aligned headers anchor the band.
  for (const p of leaves.filter((p) => p.cell.row < 2 && p.fonts.length === 1)) {
    if (proved.filter((q) => q.cell.row === p.cell.row).length !== 1) continue
    const a = p.fonts[0],
      next = leaves.find((q) => q.cell.row === p.cell.row + 1 && q.cell.column === p.cell.column)
    if (!next || next.fonts.length !== 1 || [...a.text].length !== 1) continue
    const b = next.fonts[0],
      h = a.height,
      peers = leaves.filter((q) => q.cell.row === next.cell.row && q.fonts.length === 1)
    if (
      peers.length >= 3 &&
      peers.every((q) => Math.abs(q.fonts[0].baseline - b.baseline) < h * 0.1) &&
      b.sourceItem.index === a.sourceItem.index + 1 &&
      Math.abs(b.rect[0] - a.rect[2]) < h * 0.01 &&
      Math.abs(b.height - h) < h * 0.1 &&
      a.baseline < b.baseline &&
      a.baseline - b.rect[1] > h * 0.15
    )
      conflicts.add('inline-header-split-across-rows')
  }
  // Repeated row labels alone could be a note. Require the same native column
  // positions, two value fields, and printed rules enclosing two omitted rows.
  const missingRecords = []
  for (const p of leaves.filter((p) => p.cell.column === 0 && p.fonts.length === 1)) {
    const stub = p.fonts[0],
      rowFonts = [
        ...new Map(
          table.cells
            .filter((c) => c.row === p.cell.row)
            .flatMap((c) => (c.sourceItems ?? []).map((o) => [key(o), native.get(key(o))]))
        ).values()
      ].filter((f) => f && Math.abs(f.baseline - stub.baseline) < stub.height * 0.1)
    if (rowFonts.filter((f) => /\d/u.test(f.text) && f.rect[0] > stub.rect[2]).length < 2) continue
    for (const f of unowned.filter(
      (f) =>
        f.text === stub.text &&
        f.baseline > stub.baseline + stub.height * 2 &&
        Math.abs(f.rect[0] - stub.rect[0]) < stub.height * 0.1
    )) {
      const row = unowned.filter((g) => Math.abs(g.baseline - f.baseline) < f.height * 0.1)
      if (
        row.length !== rowFonts.length ||
        !rowFonts.every((old) =>
          row.some(
            (g) =>
              Math.abs(g.rect[0] - old.rect[0]) < f.height * 0.1 &&
              Math.abs(g.height - old.height) < f.height * 0.1
          )
        )
      )
        continue
      const box = bounds(row)
      if (
        horizontal.some(
          (r) =>
            r[0] <= box[0] + 1e-6 &&
            r[2] >= box[2] - 1e-6 &&
            r[1] < box[1] &&
            box[1] - r[1] < f.height * 3
        ) &&
        horizontal.some(
          (r) =>
            r[0] <= box[0] + 1e-6 &&
            r[2] >= box[2] - 1e-6 &&
            r[1] > box[3] &&
            r[1] - box[3] < f.height * 3
        )
      )
        missingRecords.push(key(f.sourceItem))
    }
  }
  if (new Set(missingRecords).size >= 2) conflicts.add('omitted-repeated-native-records')
  for (const conflict of nativeLaneContradictions(table, owned, native, owners, horizontal))
    conflicts.add(conflict)
  return [...conflicts]
}

// Run only at final publication, after the native grid/segment recoveries. All
// inputs below are exact, uniquely owned whole native items. A contradiction
// stops mapping; it never supplies guessed rows, character splits or spans.
// These are contradictions, not recovery rules: a shared value, two headed
// measurements, or an omitted heading cannot acquire a guessed cell mapping.
function nativeBandConflicts(table, proved, native, owners, rules, horizontal) {
  const conflicts = new Set(),
    empty = (c) => !c.text?.trim() && !c.sourceItems?.length && !c.sourceSegments?.length,
    oneLine = (fonts) =>
      fonts.every((f) => Math.abs(f.baseline - fonts[0].baseline) < fonts[0].height * 0.1),
    leaf = proved.filter((p) => p.cell.rowSpan === 1 && p.cell.colSpan === 1),
    heads = leaf.filter((p) => p.cell.row === 0),
    enclosed = (box) =>
      horizontal.some((r) => r[0] <= box[0] + 1e-6 && r[2] >= box[2] - 1e-6 && r[1] < box[1]) &&
      horizontal.some((r) => r[0] <= box[0] + 1e-6 && r[2] >= box[2] - 1e-6 && r[1] > box[3])
  for (const a of table.cells.filter(
    (c) =>
      c.column === 0 &&
      c.colSpan === 1 &&
      c.rowSpan === 1 &&
      !c.sourceSegments?.length &&
      c.sourceItems?.length === 1
  )) {
    const b = table.cells.find(
        (c) =>
          c.row === a.row &&
          c.column === 1 &&
          c.colSpan === 1 &&
          c.rowSpan === 1 &&
          !c.sourceSegments?.length &&
          c.sourceItems?.length === 1 &&
          key(c.sourceItems[0]) === key(a.sourceItems[0])
      ),
      f = native.get(key(a.sourceItems[0]))
    if (
      !b ||
      !f ||
      f.sourceItem.text !== f.text ||
      owners.get(key(f.sourceItem)) !== 2 ||
      a.sourceItems[0].text !== f.text ||
      b.sourceItems[0].text !== f.text ||
      a.sourceRects?.length !== 1 ||
      b.sourceRects?.length !== 1 ||
      !rect(a.sourceRects[0]) ||
      !rect(b.sourceRects[0]) ||
      !a.text.trim() ||
      !b.text.trim() ||
      compact(a.text + b.text) !== compact(f.text)
    )
      continue
    const A = a.sourceRects[0],
      B = b.sourceRects[0],
      h = f.height
    if (
      !same([A[0], A[1], B[2], B[3]], f.rect) ||
      Math.abs(A[2] - B[0]) > 1e-6 ||
      A[2] <= A[0] ||
      B[2] <= B[0] ||
      A[3] !== B[3] ||
      A[1] !== B[1]
    )
      continue
    const peers = leaf.filter(
        (p) =>
          p.cell.column === 0 &&
          p.cell.row !== a.row &&
          Math.abs(p.box[0] - f.rect[0]) < h * 0.1 &&
          p.box[2] > A[2]
      ),
      next = leaf.filter((p) => p.cell.column === 2 && p.cell.row > 0 && p.box[0] > f.rect[2] + h)
    if (
      peers.length < 2 ||
      next.length < 2 ||
      !enclosed(bounds([f, ...peers.flatMap((p) => p.fonts), ...next.flatMap((p) => p.fonts)]))
    )
      continue
    const divider = horizontal
      .filter(
        (r) =>
          r[0] <= f.rect[0] + 1e-6 &&
          r[2] >= Math.max(...next.map((p) => p.box[2])) - 1e-6 &&
          r[1] < Math.min(f.rect[1], ...peers.map((p) => p.box[1]))
      )
      .sort((a, b) => b[1] - a[1])[0]
    if (!divider) continue
    const header = proved.filter(
      (p) => p.cell.column <= 1 && p.box[3] < divider[1] && Math.abs(p.box[0] - f.rect[0]) < h * 0.1
    )
    if (
      header.length === 1 &&
      table.cells.every(
        (c) =>
          c.column !== 1 ||
          c.row === a.row ||
          empty(c) ||
          c === header[0].cell ||
          (c.sourceItems?.length === 1 &&
            !c.sourceSegments?.length &&
            table.cells.some(
              (q) =>
                q.row === c.row &&
                q.column === 0 &&
                q.sourceItems?.length === 1 &&
                key(q.sourceItems[0]) === key(c.sourceItems[0])
            ))
      )
    )
      conflicts.add('unmeasured-source-creates-stub-column')
  }
  for (const f of native.values()) {
    if (!f || owners.has(key(f.sourceItem)) || !(table.unassigned ?? []).includes(f.text)) continue
    const lower = heads.flatMap((p) => p.fonts).filter((g) => g.rect[1] > f.rect[3])
    if (lower.length < 3 || !oneLine(lower) || !enclosed(bounds([f, ...lower]))) continue
    if (
      f.rect[0] < Math.min(...lower.map((g) => g.rect[0])) ||
      f.rect[2] > Math.max(...lower.map((g) => g.rect[2]))
    )
      continue
    if (
      heads.some(
        (p) => p.fonts.some((g) => g.rect[3] < f.rect[1]) && p.fonts.some((g) => lower.includes(g))
      )
    )
      conflicts.add('unassigned-parent-header-band')
  }
  for (const head of heads) {
    const sorted = [...head.fonts].sort((a, b) => a.rect[0] - b.rect[0]),
      last = sorted.at(-1),
      h = last.height
    if (sorted.length < 2 || !/^\p{L}{2,}$/u.test(last.text.trim())) continue
    const rest = sorted.slice(0, -1),
      left = bounds(rest)
    if (!/\p{L}{2}/u.test(rest.map((f) => f.text).join('')) || last.rect[0] - left[2] < h * 0.6)
      continue
    const lane = leaf.filter((p) => p.cell.column === head.cell.column && p.cell.row > 0)
    if (lane.length < 3 || !enclosed(bounds([...head.fonts, ...lane.flatMap((p) => p.fonts)])))
      continue
    const pairs = []
    for (const p of lane) {
      if (!oneLine(p.fonts)) break
      const a = p.fonts.filter((f) => f.rect[2] <= last.rect[0]),
        b = p.fonts.filter((f) => f.rect[0] >= last.rect[0] - h * 0.1)
      if (!a.length || !b.length || a.length + b.length !== p.fonts.length) break
      const A = bounds(a),
        B = bounds(b),
        number = /^[+−-]?\d+(?:\.\d+)?$/u
      if (
        B[0] - A[2] < h ||
        !number.test(compact(a.map((f) => f.text).join(''))) ||
        !number.test(compact(b.map((f) => f.text).join(''))) ||
        Math.abs((B[0] + B[2] - last.rect[0] - last.rect[2]) / 2) > h * 0.5
      )
        break
      pairs.push([A, B])
    }
    if (
      pairs.length === lane.length &&
      pairs.every(
        ([a, b]) =>
          Math.abs(a[2] - pairs[0][0][2]) < h * 0.2 && Math.abs(b[2] - pairs[0][1][2]) < h * 0.2
      )
    )
      conflicts.add('independent-numeric-lanes-in-leaf')
  }
  for (const group of proved.filter((p) => p.cell.rowSpan >= 3 && p.cell.colSpan === 1)) {
    const start = group.cell.row,
      end = start + group.cell.rowSpan,
      h = Math.max(...group.fonts.map((f) => f.height)),
      center = (group.box[1] + group.box[3]) / 2
    const rows = leaf.filter(
      (p) => p.cell.row >= start && p.cell.row < end && p.cell.column > group.cell.column
    )
    const full = rows.filter(
      (p) => rows.filter((q) => q.cell.column === p.cell.column).length === group.cell.rowSpan
    )
    if (!full.length) continue
    const all = bounds([...group.fonts, ...rows.flatMap((p) => p.fonts)])
    if (
      !enclosed(all) ||
      horizontal.some((r) => r[1] > all[1] && r[1] < all[3] && r[0] <= all[0] && r[2] >= all[2])
    )
      continue
    const shared = rows.filter(
      (p) =>
        p.cell.row > start &&
        p.cell.row < end - 1 &&
        Math.abs((p.box[1] + p.box[3]) / 2 - center) < h * 0.2 &&
        rows.filter((q) => q.cell.column === p.cell.column).length === 1 &&
        Array.from({ length: group.cell.rowSpan }, (_, i) => start + i)
          .filter((r) => r !== p.cell.row)
          .every((r) =>
            table.cells.some(
              (c) =>
                c.row === r &&
                c.column === p.cell.column &&
                c.rowSpan === 1 &&
                c.colSpan === 1 &&
                empty(c)
            )
          )
    )
    if (new Set(shared.map((p) => p.cell.column)).size >= 2)
      conflicts.add('centered-shared-value-missing-span')
  }
  // A numbered display derivation has a right tag lane, an empty gutter and
  // intervening prose. Without any caption or rule, it is not a data grid.
  if (
    !table.caption &&
    !rules.some(
      (r) =>
        rect(r) &&
        r[0] < table.cropRect[2] &&
        r[2] > table.cropRect[0] &&
        r[1] < table.cropRect[3] &&
        r[3] > table.cropRect[1]
    )
  ) {
    const column = table.grid[0].length - 1,
      tags = leaf
        .filter((p) => p.cell.column === column && /^\([A-Z]?\d+\)$/u.test(compact(p.cell.text)))
        .sort((a, b) => a.cell.row - b.cell.row)
    if (
      tags.length >= 2 &&
      tags.every(
        (p, i) =>
          !i ||
          ((p.cell.text.match(/[A-Z]/u)?.[0] ?? '') ===
            (tags[0].cell.text.match(/[A-Z]/u)?.[0] ?? '') &&
            Number(p.cell.text.match(/\d+/u)[0]) ===
              Number(tags[i - 1].cell.text.match(/\d+/u)[0]) + 1)
      ) &&
      tags.every(
        (p) =>
          Math.abs(p.box[2] - tags[0].box[2]) < p.fonts[0].height * 0.1 &&
          leaf.some(
            (q) =>
              q.cell.row === p.cell.row &&
              q.cell.column === 0 &&
              /[=⊆⊇≤≥≡]/u.test(q.cell.text) &&
              Math.abs(q.box[3] - p.box[3]) < p.fonts[0].height
          )
      ) &&
      table.cells.every((c) => c.column === 0 || c.column === column || empty(c)) &&
      leaf.some(
        (p) =>
          p.cell.column === 0 &&
          p.cell.row > tags[0].cell.row &&
          p.cell.row < tags.at(-1).cell.row &&
          /(?:\p{L}{2,}\s+){4}\p{L}{2,}/u.test(p.cell.text)
      )
    )
      conflicts.add('numbered-derivation-mapped-as-table')
  }
  return [...conflicts]
}

// Whole native owners can disprove a published row/column without supplying a
// replacement. Measured segments and explicit spans deliberately cannot anchor
// these checks; each independent native baseline remains reviewable verbatim.
function nativeRecordContradictions(table, owned, native, owners, horizontal, inventory) {
  const conflicts = new Set(nativeMergedRecordConflicts(table, owned)),
    leaves = owned.filter((p) => p.cell.rowSpan === 1 && p.cell.colSpan === 1),
    body = leaves.filter((p) => p.cell.row > 0),
    scalar = (s) => /^(?:[<>≤≥]\s*)?[+−-]?(?:\d+(?:[.,/]\d+)?|[.,]\d+)%?$/u.test(compact(s)),
    lines = (p) => {
      const h = Math.max(...p.fonts.map((f) => f.height)),
        result = []
      for (const f of [...p.fonts].sort(
        (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
      )) {
        if (!Number.isFinite(f.baseline) || f.height < h * 0.8) return []
        const last = result.at(-1)
        if (last && Math.abs(last[0].baseline - f.baseline) < h * 0.15) last.push(f)
        else result.push([f])
      }
      return result
    },
    text = (ff) => compact(ff.map((f) => f.text).join('')),
    near = (a, b, h) => Math.abs(a - b) < h * 0.2,
    empty = (c) => !c.text?.trim() && !c.sourceItems?.length && !c.sourceSegments?.length
  if (nativeSplitSectionRecord(table, owned, native, owners, horizontal, inventory))
    conflicts.add('native-section-and-projected-record-conflict')
  if (nativeDetachedScientificScript(table, owned, native, owners, inventory))
    conflicts.add('native-script-crosses-record-owner')
  // A numeric heading and two rows share four distinct scalar lanes. The last
  // claimed leaf cannot consume both terminal lanes when two other independent
  // scalar columns repeat exactly those baselines and alignment positions.
  const lastColumn = table.grid[0].length - 1,
    pairs = []
  for (const p of leaves.filter((p) => p.cell.column === lastColumn)) {
    const ll = lines(p)
    if (ll.length !== 1) continue
    const h = ll[0][0].height,
      groups = []
    for (const f of ll[0]) {
      const last = groups.at(-1)
      if (last && f.rect[0] - last.at(-1).rect[2] < h * 0.5) last.push(f)
      else groups.push([f])
    }
    if (
      groups.length !== 2 ||
      groups.some((g) => !scalar(text(g)) && !(p.cell.row > 0 && /^[—–-]$/u.test(text(g))))
    )
      continue
    const boxes = groups.map(bounds)
    if (boxes[1][0] - boxes[0][2] <= h) continue
    const peers = leaves.filter((q) => {
      const rows = lines(q)
      return (
        q.cell.row === p.cell.row &&
        q.cell.column > 0 &&
        q.cell.column < lastColumn &&
        rows.length === 1 &&
        scalar(text(rows[0])) &&
        near(rows[0][0].baseline, ll[0][0].baseline, h) &&
        q.box[2] < boxes[0][0]
      )
    })
    if (new Set(peers.map((q) => q.cell.column)).size >= 2) pairs.push({ p, boxes, h })
  }
  for (const head of pairs.filter((p) => p.p.cell.row === 0)) {
    const aligned = pairs.filter(
      (q) =>
        q.p.cell.row > 0 &&
        q.boxes.every((b, i) =>
          [0, 1, 2].some((axis) => {
            const anchor = (r) => (axis === 1 ? (r[0] + r[2]) / 2 : r[axis])
            return near(anchor(b), anchor(head.boxes[i]), Math.min(q.h, head.h) * 2)
          })
        )
    )
    if (new Set(aligned.map((q) => q.p.cell.row)).size >= 2)
      conflicts.add('numeric-headed-terminal-lanes-collapsed')
  }
  // Repeated panel labels independently identify the first panel's missing
  // rows. Numeric multiline headings alone do not establish a record boundary.
  const firstStub = leaves.find((p) => p.cell.row === 0 && p.cell.column === 0)
  if (firstStub) {
    const h = Math.max(...firstStub.fonts.map((f) => f.height)),
      labelLines = lines({ fonts: firstStub.fonts.filter((f) => f.height >= h * 0.8) })
    if (labelLines.length === 3) {
      const following = body.filter((p) => p.cell.column === 0 && lines(p).length === 1),
        repeated = following.some((a) =>
          following.some(
            (b) =>
              b.cell.row === a.cell.row + 1 &&
              compact(a.cell.text) === text(labelLines[1]) &&
              compact(b.cell.text) === text(labelLines[2])
          )
        ),
        columns = leaves.filter((p) => {
          const ll = lines(p)
          return (
            p.cell.row === 0 &&
            p.cell.column > 0 &&
            ll.length === 3 &&
            ll.every((l, i) => scalar(text(l)) && near(l[0].baseline, labelLines[i][0].baseline, h))
          )
        })
      if (
        repeated &&
        columns.length >= 3 &&
        horizontal.some(
          (r) =>
            r[0] <= firstStub.box[0] &&
            r[2] >= Math.max(...columns.map((p) => p.box[2])) &&
            r[1] > firstStub.box[3] &&
            r[1] < Math.min(...following.map((p) => p.box[1]))
        )
      )
        conflicts.add('repeated-metric-panel-rows-collapsed')
    }
  }
  // A repeated whole stub and two distinct threshold baselines identify two
  // records. A wrapped label, multiline value, or explicit spanning cell alone
  // cannot establish this contradiction.
  for (const stub of body.filter((p) => p.cell.column === 0)) {
    const ll = lines(stub),
      h = stub.fonts[0].height
    if (
      ll.length !== 2 ||
      ll.some((l) => l.length !== 1 || !/\p{L}{2}/u.test(l[0].text)) ||
      text(ll[0]) !== text(ll[1]) ||
      !near(ll[0][0].rect[0], ll[1][0].rect[0], h) ||
      ll[1][0].baseline - ll[0][0].baseline < h
    )
      continue
    const peer = body.find((p) => {
      if (p.cell.row !== stub.cell.row || p.cell.column !== 1) return false
      const other = lines(p)
      return (
        other.length === 2 &&
        other.every((l, i) => scalar(text(l)) && near(l[0].baseline, ll[i][0].baseline, h)) &&
        text(other[0]) !== text(other[1])
      )
    })
    if (
      peer &&
      body.filter(
        (p) =>
          p.cell.row === stub.cell.row &&
          p.cell.column > 1 &&
          lines(p).length === 1 &&
          scalar(p.cell.text) &&
          near(p.fonts[0].baseline, ll[0][0].baseline, h)
      ).length >= 2
    )
      conflicts.add('repeated-stub-records-collapsed')
  }
  // A header native run partitioned into two exhaustive claimed rectangles
  // cannot justify moving every complete body parent across an empty first
  // field. Require a printed header divider and three aligned whole parents;
  // no character boundary or replacement ID is inferred from the parent text.
  for (const a of table.cells.filter((c) => c.row === 0 && c.column === 0)) {
    const b = table.cells.find((c) => c.row === 0 && c.column === 1)
    if (
      !b ||
      a.rowSpan !== 1 ||
      a.colSpan !== 1 ||
      b.rowSpan !== 1 ||
      b.colSpan !== 1 ||
      a.sourceSegments?.length ||
      b.sourceSegments?.length ||
      a.sourceItems?.length !== 1 ||
      b.sourceItems?.length !== 1 ||
      key(a.sourceItems[0]) !== key(b.sourceItems[0])
    )
      continue
    const f = native.get(key(a.sourceItems[0])),
      A = a.sourceRects?.[0],
      B = b.sourceRects?.[0]
    if (
      !f ||
      owners.get(key(f.sourceItem)) !== 2 ||
      f.sourceItem.text !== f.text ||
      a.sourceItems[0].text !== f.text ||
      b.sourceItems[0].text !== f.text ||
      !a.text.trim() ||
      !b.text.trim() ||
      compact(a.text + b.text) !== compact(f.text) ||
      !same([A?.[0], A?.[1], B?.[2], B?.[3]], f.rect) ||
      !rect(A) ||
      !rect(B) ||
      !near(A[2], B[0], 1e-5)
    )
      continue
    const h = f.height,
      crossing = body.filter(
        (p) =>
          p.cell.column === 1 &&
          p.fonts.length === 1 &&
          /^[\p{L}]?\d+\s+\S/u.test(p.fonts[0].text) &&
          near(p.box[0], f.rect[0], h) &&
          p.box[2] > B[2] + h &&
          table.cells.some((c) => c.row === p.cell.row && c.column === 0 && empty(c))
      )
    if (
      crossing.length >= 3 &&
      !body.some((p) => p.cell.column === 0) &&
      horizontal.some(
        (r) =>
          r[0] <= f.rect[0] &&
          r[2] >= Math.max(...crossing.map((p) => p.box[2])) &&
          r[1] > f.rect[3] &&
          r[1] < Math.min(...crossing.map((p) => p.box[1]))
      )
    )
      conflicts.add('whole-native-parent-crosses-empty-stub')
  }
  // Two omitted printed headings and a ruled divider anchor a short reference
  // lane independently of the prose. Repeated whole right-edge letters cannot
  // be inserted into the paragraph merely because its source owner survives.
  for (const head of [...native.values()].filter(
    (f) =>
      f &&
      !owners.has(key(f.sourceItem)) &&
      table.unassigned?.includes(f.text) &&
      /^[\p{L}.]{2,12}$/u.test(f.text.trim())
  )) {
    const h = head.height,
      label = [...native.values()].find(
        (f) =>
          f &&
          f !== head &&
          !owners.has(key(f.sourceItem)) &&
          table.unassigned?.includes(f.text) &&
          /\p{L}{3}/u.test(f.text) &&
          f.rect[2] < head.rect[0] &&
          near(f.baseline, head.baseline, h)
      ),
      detached = leaves.filter((p) => {
        const codes = p.fonts.filter(
          (f) =>
            /^\p{L}$/u.test(f.text.trim()) &&
            near((f.rect[0] + f.rect[2]) / 2, (head.rect[0] + head.rect[2]) / 2, h * 2)
        )
        if (codes.length !== 1) return false
        const code = codes[0],
          rest = p.fonts.filter((f) => f !== code)
        return (
          rest.length >= 2 &&
          rest.some((f) => /\p{L}{2}/u.test(f.text)) &&
          rest.every((f) => f.rect[2] < code.rect[0] - h * 0.5) &&
          near(code.baseline, Math.min(...rest.map((f) => f.baseline)), h) &&
          p.box[1] > head.rect[3]
        )
      })
    if (
      label &&
      detached.length >= 3 &&
      horizontal.some(
        (r) =>
          r[0] <= label.rect[0] &&
          r[2] >= head.rect[2] &&
          r[1] > head.rect[3] &&
          r[1] < Math.min(...detached.map((p) => p.box[1]))
      )
    )
      conflicts.add('omitted-headed-reference-lane')
  }
  // Whole native paragraph blocks were painted column by column within each
  // record, then restart at column zero below that block. Repeating that order
  // in separate bands with ragged line counts contradicts a leaf row per line.
  const heads = leaves.filter((p) => p.cell.row === 0),
    columnCount = table.grid[0].length
  if (columnCount >= 3 && heads.length === columnCount && body.length >= columnCount * 4) {
    const atoms = body
        .flatMap((p) => p.fonts.map((f) => ({ p, f })))
        .sort((a, b) => a.f.sourceItem.index - b.f.sourceItem.index),
      runs = []
    for (const a of atoms) {
      const last = runs.at(-1)
      if (last && last[0].p.cell.column === a.p.cell.column) last.push(a)
      else runs.push([a])
    }
    let blocks = 0
    for (let start = 0; start + columnCount <= runs.length; start++) {
      const group = runs.slice(start, start + columnCount)
      if (group.some((g, col) => g[0].p.cell.column !== col)) continue
      const rows = group.map((g) => [...new Set(g.map((a) => a.p.cell.row))]),
        ff = group.flat().map((a) => a.f),
        box = bounds(ff),
        h = Math.min(...ff.map((f) => f.height))
      if (
        rows.some((r) => r.length < 2) ||
        new Set(rows.map((r) => r.length)).size < 2 ||
        Math.max(...rows.map((r) => r.length)) < 3 ||
        group.some((g) => g.some((a) => !/\p{L}{2}/u.test(a.p.cell.text))) ||
        group.some((g) => g.some((a) => !near(a.p.box[0], g[0].p.box[0], h * 2))) ||
        group.some((g) => g.some((a, i) => i && a.f.baseline < g[i - 1].f.baseline - h * 0.15)) ||
        [...native.values()].some(
          (f) =>
            f &&
            !ff.includes(f) &&
            !owned.some(
              (p) =>
                p.cell.rowSpan > 1 &&
                p.fonts.includes(f) &&
                p.box[0] >= box[0] &&
                p.box[2] <= box[2] &&
                p.box[1] >= box[1] &&
                p.box[3] <= box[3]
            ) &&
            f.rect[0] >= box[0] &&
            f.rect[2] <= box[2] &&
            f.rect[1] >= box[1] &&
            f.rect[3] <= box[3]
        ) ||
        horizontal.some(
          (r) => r[0] <= box[0] && r[2] >= box[2] && r[1] > box[1] && r[1] < box[3]
        ) ||
        !horizontal.some(
          (r) =>
            r[0] <= box[0] &&
            r[2] >= box[2] &&
            r[1] > Math.max(...heads.map((p) => p.box[3])) &&
            r[1] < box[1]
        )
      )
        continue
      blocks++
    }
    if (blocks >= 2) conflicts.add('native-paragraph-blocks-split-into-line-rows')
  }
  return [...conflicts]
}

// These source packets contradict a published owner; they do not infer a new
// grid. Require original font/geometry and the entire native packet, including
// foreign sources in its stream interval, before applying the existing warning.
function nativeSourcePacketConflicts(table, owned, inventory, rules, context, measuredRuns) {
  const content = context?.sourceContent,
    transform = context?.viewport?.transform,
    validRect = (r) => rect(r) && r[2] > r[0] && r[3] > r[1],
    font = (f) => {
      const item = content?.items?.[f.sourceItem.index],
        style = content?.styles?.[item?.fontName]
      if (
        !Array.isArray(transform) ||
        transform.length !== 6 ||
        !transform.every(Number.isFinite) ||
        !(transform[0] > 0) ||
        transform[1] !== 0 ||
        transform[2] !== 0 ||
        transform[3] !== -transform[0] ||
        f.sourceItem.pageNumber !== table.page ||
        !item ||
        item.dir !== 'ltr' ||
        item.str !== f.text ||
        typeof item.fontName !== 'string' ||
        !style ||
        !Number.isFinite(style.ascent) ||
        !Number.isFinite(style.descent) ||
        !(style.ascent > 0) ||
        style.ascent <= style.descent ||
        style.vertical !== false ||
        !Array.isArray(item.transform) ||
        item.transform.length !== 6 ||
        !item.transform.every(Number.isFinite) ||
        !(item.transform[0] > 0) ||
        !(item.transform[3] > 0) ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        !Number.isFinite(item.width) ||
        !(item.width > 0) ||
        !Number.isFinite(item.height) ||
        !(item.height > 0) ||
        item.height !== item.transform[3]
      )
        return
      const scale = transform[0],
        x = item.transform[4] * scale + transform[4],
        y = item.transform[5] * transform[3] + transform[5],
        height = item.height * scale
      return same(f.rect, [x, y - height, x + item.width * scale, y]) &&
        Math.abs(f.baseline - y) < 1e-6 &&
        Math.abs(f.height - height) < 1e-6
        ? item
        : undefined
    },
    leaves = owned.filter(
      (p) =>
        p.cell.rowSpan === 1 &&
        p.cell.colSpan === 1 &&
        compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join('')) &&
        p.fonts.every((f) => validRect(f.rect) && font(f))
    ),
    body = leaves.filter((p) => p.cell.row > 0),
    fontEnvelope = (f) => {
      const item = font(f),
        style = content?.styles?.[item?.fontName]
      return item
        ? [
            f.rect[0],
            Math.min(f.rect[1], f.baseline - style.ascent * f.height),
            f.rect[2],
            Math.max(f.rect[3], f.baseline - style.descent * f.height)
          ]
        : undefined
    },
    foreignFree = (ff) => {
      const b = bounds(ff.map((f) => ({ rect: fontEnvelope(f) }))),
        ids = new Set(ff.map(fontKey)),
        lo = Math.min(...ff.map((f) => f.sourceItem.index)),
        hi = Math.max(...ff.map((f) => f.sourceItem.index))
      return inventory.every((f) => {
        if (!f.text?.trim()) return true
        if (!canonicalNativeFont(f) || !validRect(f.rect)) return false
        const r = fontEnvelope(f)
        return (
          r &&
          (ids.has(fontKey(f)) ||
            ((r[0] >= b[2] || r[2] <= b[0] || r[1] >= b[3] || r[3] <= b[1]) &&
              (f.sourceItem.index < lo || f.sourceItem.index > hi)))
        )
      })
    },
    horizontal = rules.filter((r) => rect(r) && r[1] === r[3] && r[2] > r[0]),
    count = table.grid[0].length,
    heads = leaves.filter((p) => p.cell.row === 0),
    conflicts = []
  conflicts.push(
    ...nativeCalibratedRecordPackets(table, inventory, font, rules, context),
    ...nativeCalibratedValueLaneSplit(table, inventory, font),
    ...nativeWrappedWordPrefixConflicts(owned, inventory, font),
    ...nativePrintedRecordConflicts(table, owned, inventory, rules, font, context, fontEnvelope)
  )
  if (nativeDuplicatedParentSource(table, inventory, font, fontEnvelope))
    conflicts.push('native-parent-source-duplicated-in-leaf')
  if (nativeOrdinalRecordTail(table, leaves, inventory, rules, font, content))
    conflicts.push('native-ordinal-record-tail-crosses-row')
  if (nativeTerminalNumberedRecordTail(table, owned, inventory, rules, font, content, context))
    conflicts.push('native-terminal-numbered-record-continuation-split')
  if (heads.length !== count) return conflicts
  const packet = {
    table,
    owned,
    inventory,
    font,
    fontEnvelope,
    leaves,
    body,
    foreignFree,
    heads,
    count
  }
  if (nativeAttachedSuffixAcrossCell(packet)) conflicts.push('native-attached-suffix-crosses-cell')
  if (nativeMeasuredTailAcrossLanes(packet, measuredRuns))
    conflicts.push('native-measured-source-crosses-header-lanes')
  // Two independent hyphenated words continue across the same proposed row
  // boundary. Complete column-by-column source packets and a header divider
  // distinguish this from arbitrary short sentences or one wrapped label.
  if (count >= 3)
    for (const row of new Set(body.map((p) => p.cell.row))) {
      const groups = [],
        pairs = []
      for (let col = 0; col < count; col++) {
        const a = body.find((p) => p.cell.row === row && p.cell.column === col),
          b = body.find((p) => p.cell.row === row + 1 && p.cell.column === col)
        if (!a || !b) break
        groups.push([...a.fonts, ...b.fonts])
        const aa = [...a.fonts].sort((a, b) => a.sourceItem.index - b.sourceItem.index),
          bb = [...b.fonts].sort((a, b) => a.sourceItem.index - b.sourceItem.index),
          last = aa.at(-1),
          first = bb[0],
          h = last.height
        if (
          /\p{L}-$/u.test(last.text) &&
          /^\p{Ll}/u.test(first.text) &&
          font(last).fontName === font(first).fontName &&
          Math.abs(first.height - h) < h * 0.02 &&
          first.baseline - last.baseline > h &&
          first.baseline - last.baseline < h * 1.4 &&
          Math.abs(first.rect[0] - a.box[0]) < h * 0.05 &&
          first.sourceItem.index === last.sourceItem.index + 1 &&
          aa.every(
            (f) =>
              Math.abs(f.baseline - last.baseline) < h * 0.05 && Math.abs(f.height - h) < h * 0.02
          )
        )
          pairs.push({ last, first })
      }
      if (groups.length !== count || pairs.length < 2) continue
      const ff = groups.flat(),
        b = bounds(ff)
      if (
        groups
          .slice(1)
          .some(
            (g, n) =>
              Math.min(...g.map((f) => f.sourceItem.index)) <=
              Math.max(...groups[n].map((f) => f.sourceItem.index))
          ) ||
        !foreignFree(ff) ||
        !horizontal.some(
          (r) =>
            r[0] <= b[0] &&
            r[2] >= b[2] &&
            r[1] > Math.max(...heads.map((p) => p.box[3])) &&
            r[1] < b[1]
        ) ||
        horizontal.some(
          (r) =>
            r[0] <= b[0] &&
            r[2] >= b[2] &&
            r[1] > Math.max(...pairs.map((p) => p.last.baseline)) &&
            r[1] < Math.min(...pairs.map((p) => p.first.baseline))
        )
      )
        continue
      conflicts.push('native-paired-wrapped-words-split')
      break
    }
  // Repeated two-row native packets calibrate a centered stub independently
  // of quantized model row cuts. Three already complete spans must establish
  // the same role before a one-row stub and its empty peer can contradict it.
  // This only declines that structure; it does not reconstruct a row span.
  const repeatedStubConflict = () => {
    if (count < 4 || table.grid.length < 9 || (table.grid.length - 1) % 2) return false
    const groups = []
    for (let row = 1; row < table.grid.length; row += 2) {
      const stubs = owned.filter(
          (p) =>
            p.cell.column === 0 &&
            (p.cell.row === row || p.cell.row === row + 1) &&
            p.cell.colSpan === 1 &&
            p.fonts.length === 1 &&
            compact(p.cell.text) === compact(p.fonts[0].text) &&
            font(p.fonts[0])
        ),
        values = [row, row + 1].map((r) =>
          body
            .filter((p) => p.cell.row === r && p.cell.column > 0)
            .sort((a, b) => a.cell.column - b.cell.column)
        )
      if (
        stubs.length !== 1 ||
        values.some(
          (vv) =>
            vv.length !== count - 1 ||
            vv.some((p, n) => p.cell.column !== n + 1 || p.fonts.length !== 1)
        )
      )
        return false
      const stub = stubs[0],
        first = stub.fonts[0],
        h = first.height,
        base = values.map((vv) => vv[0].fonts[0].baseline),
        ff = [first, ...values.flatMap((vv) => vv.flatMap((p) => p.fonts))],
        complete = stub.cell.row === row && stub.cell.rowSpan === 2,
        peer = table.cells.filter(
          (c) => c.column === 0 && c.row === (stub.cell.row === row ? row + 1 : row)
        )
      if (
        (!complete &&
          (stub.cell.rowSpan !== 1 ||
            peer.length !== 1 ||
            peer[0].rowSpan !== 1 ||
            peer[0].colSpan !== 1 ||
            peer[0].text?.trim() ||
            peer[0].sourceItems?.length ||
            peer[0].sourceRects?.length ||
            peer[0].sourceSegments?.length)) ||
        base[1] - base[0] <= h ||
        base[1] - base[0] >= h * 1.4 ||
        Math.abs(first.baseline - (base[0] + base[1]) / 2) >= h * 0.05 ||
        values.some((vv, line) =>
          vv.some(
            (p, n) =>
              Math.abs(p.fonts[0].baseline - base[line]) >= h * 0.02 ||
              Math.abs(p.fonts[0].height - h) >= h * 0.02 ||
              p.box[0] <= first.rect[2] + h ||
              (n > 0 && !/^[+−-]?\d+(?:\.\d+)?$/u.test(p.fonts[0].text))
          )
        ) ||
        first.sourceItem.index !== Math.min(...ff.map((f) => f.sourceItem.index)) ||
        Math.max(...values[0].flatMap((p) => p.fonts.map((f) => f.sourceItem.index))) >=
          Math.min(...values[1].flatMap((p) => p.fonts.map((f) => f.sourceItem.index))) ||
        !foreignFree(ff) ||
        horizontal.some(
          (r) => r[0] <= bounds(ff)[0] && r[2] >= bounds(ff)[2] && r[1] > base[0] && r[1] < base[1]
        )
      )
        return false
      groups.push({ first, h, base, complete, ff })
    }
    const reference = groups[0],
      all = groups.flatMap((g) => g.ff),
      b = bounds(all)
    return (
      groups.filter((g) => g.complete).length >= 3 &&
      groups.some((g) => !g.complete) &&
      groups.every(
        (g) =>
          font(g.first).fontName === font(reference.first).fontName &&
          Math.abs(g.h - reference.h) < reference.h * 0.02 &&
          Math.abs(g.first.rect[0] - reference.first.rect[0]) < reference.h * 0.05 &&
          Math.abs(
            g.first.baseline -
              (g.base[0] + g.base[1]) / 2 -
              (reference.first.baseline - (reference.base[0] + reference.base[1]) / 2)
          ) <
            reference.h * 0.02
      ) &&
      horizontal.some(
        (r) =>
          r[0] <= b[0] &&
          r[2] >= b[2] &&
          r[1] > Math.max(...heads.map((p) => p.box[3])) &&
          r[1] < b[1]
      )
    )
  }
  if (repeatedStubConflict()) conflicts.push('native-repeated-two-row-stub-inconsistent')
  // Atomic symbol stubs, complete independent value/reference sources and a
  // repeated row-major source program establish separate parameter records.
  // Ordinary multiline descriptions and explicit row spans cannot anchor it.
  if (count === 4)
    for (const stub of body.filter((p) => p.cell.column === 0)) {
      const h = Math.max(...stub.fonts.map((f) => f.height)),
        bases = stub.fonts
          .filter((f) => f.height >= h * 0.95)
          .sort((a, b) => a.baseline - b.baseline),
        peers = body.filter((p) => p.cell.row === stub.cell.row)
      if (
        bases.length < 3 ||
        peers.length !== 4 ||
        bases.some((f) => !/^\p{L}$/u.test(f.text)) ||
        bases
          .slice(1)
          .some(
            (f, n) =>
              f.baseline - bases[n].baseline <= h || f.baseline - bases[n].baseline >= h * 1.6
          )
      )
        continue
      const ff = peers.flatMap((p) => p.fonts),
        runs = []
      for (const f of [...ff].sort((a, b) => a.sourceItem.index - b.sourceItem.index)) {
        const col = peers.find((p) => p.fonts.includes(f)).cell.column,
          last = runs.at(-1)
        if (last?.column === col) last.fonts.push(f)
        else runs.push({ column: col, fonts: [f] })
      }
      if (
        runs.length !== bases.length * 4 ||
        runs.some((g, n) => g.column !== n % 4) ||
        !foreignFree(ff)
      )
        continue
      const centers = []
      if (
        bases.some((base, n) => {
          const groups = runs.slice(n * 4, n * 4 + 4),
            label = groups[0].fonts
          centers.push((bounds(label)[0] + bounds(label)[2]) / 2)
          return (
            !label.includes(base) ||
            label.length > 2 ||
            label.some(
              (s) =>
                s !== base &&
                (!/^\p{L}$/u.test(s.text) ||
                  s.height <= h * 0.5 ||
                  s.height >= h * 0.85 ||
                  s.baseline < base.baseline ||
                  s.baseline - base.baseline >= h * 0.25 ||
                  Math.abs(s.rect[0] - base.rect[2]) >= h * 0.05 ||
                  s.sourceItem.index !== base.sourceItem.index + 1)
            ) ||
            !groups[1].fonts.some(
              (f) => /\p{L}{3}/u.test(f.text) && Math.abs(f.baseline - base.baseline) < h * 0.05
            ) ||
            groups
              .slice(2)
              .some(
                (g) =>
                  g.fonts.length !== 1 ||
                  Math.abs(g.fonts[0].baseline - base.baseline) >= h * 0.05 ||
                  Math.abs(g.fonts[0].height - h) >= h * 0.02
              ) ||
            !/^(?:\[[\d/.,\s]+\]|\p{L}{2,20})$/u.test(groups[2].fonts[0].text) ||
            !/^(?:\[[\d,\s]+\]|[—–-])$/u.test(groups[3].fonts[0].text)
          )
        }) ||
        Math.max(...centers) - Math.min(...centers) >= h * 0.1
      )
        continue
      conflicts.push('native-independent-symbol-records-merged')
      break
    }
  return conflicts
}

// Two independent scientific records calibrate a native base/exponent pair.
// A later consecutive pair cannot give its exponent to the preceding record
// while leaving its base unassigned. This only disproves that owner; it does
// not reconstruct the missing record or change its image and native text.
function nativeDetachedScientificScript(table, owned, native, owners, inventory) {
  const good = (f) =>
      f &&
      f.horizontal &&
      f.sourceItem.pageNumber === table.page &&
      Number.isSafeInteger(f.sourceItem.index) &&
      f.sourceItem.index >= 0 &&
      f.sourceItem.text === f.text &&
      Number.isFinite(f.baseline) &&
      Number.isFinite(f.fontAscent) &&
      Number.isFinite(f.fontDescent) &&
      f.fontAscent > f.fontDescent &&
      Number.isFinite(f.height) &&
      f.height > 0 &&
      f.rect[0] < f.rect[2] &&
      Math.abs(f.rect[3] - f.baseline) < 1e-6 &&
      Math.abs(f.rect[3] - f.rect[1] - f.height) < 1e-6 &&
      f.rect.every((v, n) => (n < 2 ? v >= table.cropRect[n] : v <= table.cropRect[n])),
    near = (a, b, h) => Math.abs(a - b) < h * 0.05,
    metric = (a, b) => a.fontAscent === b.fontAscent && a.fontDescent === b.fontDescent,
    consecutive = (a, b) =>
      a.sourceItem.index < b.sourceItem.index &&
      !inventory.some(
        (f) =>
          f.text?.trim() &&
          f.sourceItem?.pageNumber === table.page &&
          f.sourceItem.index > a.sourceItem.index &&
          f.sourceItem.index < b.sourceItem.index
      ),
    pair = (base, script) =>
      good(base) &&
      good(script) &&
      base.text === '10' &&
      /^[+−-]?\d+$/u.test(script.text) &&
      metric(base, script) &&
      script.height > base.height * 0.55 &&
      script.height < base.height * 0.85 &&
      base.baseline - script.baseline > base.height * 0.2 &&
      base.baseline - script.baseline < base.height * 0.5 &&
      near(base.rect[2], script.rect[0], base.height) &&
      consecutive(base, script),
    exact = (p) =>
      p.cell.rowSpan === 1 &&
      p.cell.colSpan === 1 &&
      !p.cell.sourceSegments?.length &&
      p.fonts.every(good) &&
      compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join('')) &&
      p.fonts.every((f, n) => !n || f.sourceItem.index > p.fonts[n - 1].sourceItem.index),
    scientific = (ff) =>
      /^(?:[+−-]?\d+(?:\.\d+)?×)?10[+−-]?\d+$/u.test(compact(ff.map((f) => f.text).join('')))
  for (const p of owned.filter((p) => p.cell.row >= 3 && exact(p))) {
    for (const script of p.fonts) {
      const bases = [...native.values()].filter(
        (f) =>
          f &&
          !owners.has(key(f.sourceItem)) &&
          table.unassigned?.includes(f.text) &&
          pair(f, script)
      )
      if (bases.length !== 1) continue
      const base = bases[0],
        core = p.fonts.filter((f) => f !== script),
        intact = core.flatMap((b) =>
          core.filter((s) => pair(b, s)).map((s) => ({ base: b, script: s }))
        )
      if (intact.length !== 1 || !scientific(core)) continue
      const current = intact[0],
        h = current.base.height,
        y = current.base.baseline,
        step = base.baseline - y
      if (
        step < h * 0.8 ||
        step > h * 2 ||
        script.baseline <= y + h * 0.5 ||
        !metric(base, current.base) ||
        !near(base.height, h, h) ||
        !near(base.rect[2], current.base.rect[2], h) ||
        !near(base.baseline - script.baseline, y - current.script.baseline, h) ||
        !near(script.height, current.script.height, h) ||
        core.some(
          (f) => f !== current.script && (!near(f.baseline, y, h) || !near(f.height, h, h))
        ) ||
        base.sourceItem.index <= Math.max(...core.map((f) => f.sourceItem.index))
      )
        continue
      const witnesses = [p.cell.row - 2, p.cell.row - 1].map((row) =>
        owned.filter((q) => q.cell.row === row && q.cell.column === p.cell.column && exact(q))
      )
      if (witnesses.some((qq) => qq.length !== 1)) continue
      const witnessPairs = witnesses.map(([q]) => {
        if (!scientific(q.fonts)) return []
        return q.fonts.flatMap((b) =>
          q.fonts.filter((s) => pair(b, s)).map((s) => ({ q, base: b, script: s }))
        )
      })
      if (witnessPairs.some((pp) => pp.length !== 1)) continue
      const previous = witnessPairs.map(([q]) => q)
      if (
        previous.some(
          (q, n) =>
            !metric(q.base, current.base) ||
            !near(q.base.height, h, h) ||
            !near(q.base.rect[2], base.rect[2], h) ||
            !near(q.base.baseline, y - step * (2 - n), h) ||
            !near(q.base.baseline - q.script.baseline, y - current.script.baseline, h) ||
            !near(q.script.height, script.height, h) ||
            q.q.fonts.some(
              (f) =>
                f !== q.script && (!near(f.baseline, q.base.baseline, h) || !near(f.height, h, h))
            )
        ) ||
        Math.max(...previous[0].q.fonts.map((f) => f.sourceItem.index)) >=
          Math.min(...previous[1].q.fonts.map((f) => f.sourceItem.index)) ||
        Math.max(...previous[1].q.fonts.map((f) => f.sourceItem.index)) >=
          Math.min(...core.map((f) => f.sourceItem.index))
      )
        continue
      return true
    }
  }
  return false
}

// This is a contradiction certificate, not a recovered section or new grid.
// A complete native title baseline is split between adjacent model rows while
// a separately repeated four-or-more-column numeric record is also collapsed.
// Printed dividers constrain the shared band; their geometry is not an opaque
// paint or glyph-outline certificate and is never used to change the crop.
function nativeSplitSectionRecord(table, owned, native, owners, horizontal, inventory) {
  const columns = table.grid[0]?.length,
    point = (s) => /^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(compact(s)),
    near = (a, b) => Math.abs(a - b) < 1e-6,
    good = (f) =>
      f &&
      f.sourceItem.text === f.text &&
      Number.isFinite(f.baseline) &&
      Number.isFinite(f.height) &&
      f.height > 0 &&
      f.rect[0] < f.rect[2] &&
      f.rect[1] < f.rect[3] &&
      Number.isSafeInteger(f.sourceItem.index) &&
      f.sourceItem.index >= 0 &&
      Number.isSafeInteger(f.sourceItem.pageNumber) &&
      f.sourceItem.pageNumber > 0,
    exact = (p) =>
      p.fonts.every(good) && compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join('')),
    baseline = (ff) => ff.length && ff.every((f) => good(f) && near(f.baseline, ff[0].baseline)),
    literal = (ff) => ff.map((f) => f.text).join(''),
    firstKey = (ff) => Math.min(...ff.map((f) => f.sourceItem.index)),
    lastKey = (ff) => Math.max(...ff.map((f) => f.sourceItem.index))
  if (!Number.isInteger(columns) || columns < 4 || columns > 8) return false
  for (const p of owned.filter(
    (p) =>
      p.cell.row > 0 &&
      p.cell.column === 0 &&
      p.cell.rowSpan === 1 &&
      p.cell.colSpan === 1 &&
      exact(p)
  )) {
    const labels = p.fonts.filter((f) => /^\p{L}{2,}$/u.test(f.text)),
      number = p.fonts.filter((f) => !labels.includes(f))
    if (labels.length !== 1 || !baseline(number) || !point(literal(number))) continue
    const label = labels[0],
      h = number[0].height,
      y = number[0].baseline,
      next = [p.cell.row + 1, p.cell.row + 2].map((row) =>
        owned.filter(
          (q) => q.cell.row === row && q.cell.rowSpan === 1 && q.cell.colSpan === 1 && exact(q)
        )
      )
    if (
      next.some(
        (row) =>
          row.length !== columns ||
          new Set(row.map((q) => q.cell.column)).size !== columns ||
          row.some((q) => !baseline(q.fonts) || !point(literal(q.fonts)))
      )
    )
      continue
    const yy = next.map((row) => row[0].fonts[0].baseline),
      allNext = next.map((row) => row.flatMap((q) => q.fonts))
    if (
      allNext.some(
        (ff) =>
          !baseline(ff) ||
          ff.some(
            (f) =>
              Math.abs(f.height - h) > h * 0.1 ||
              f.sourceItem.pageNumber !== label.sourceItem.pageNumber
          )
      ) ||
      !(yy[0] > y && yy[1] > yy[0]) ||
      Math.abs(yy[0] - y - (yy[1] - yy[0])) > h * 0.2 ||
      yy[0] - y < h * 0.8 ||
      yy[0] - y > h * 2 ||
      Math.abs(y - label.baseline - (yy[0] - y)) > h * 0.2
    )
      continue
    const lanes = Array.from({ length: columns }, (_, column) =>
      next.map((row) => row.find((q) => q.cell.column === column))
    )
    if (
      lanes.some(
        (pair) =>
          pair.some((q) => !q) ||
          Math.abs((pair[0].box[0] + pair[0].box[2] - pair[1].box[0] - pair[1].box[2]) / 2) >
            h * 0.3
      )
    )
      continue
    const edges = lanes.map((pair) => [
      Math.min(...pair.map((q) => q.box[0])),
      Math.max(...pair.map((q) => q.box[2]))
    ])
    if (edges.some((r, n) => n && r[0] <= edges[n - 1][1])) continue
    const current = owned.filter(
        (q) => q.cell.row === p.cell.row && q.cell.rowSpan === 1 && exact(q)
      ),
      spans = current.filter(
        (q) => q.cell.column > 0 && q.cell.colSpan >= 2 && q.cell.column + q.cell.colSpan < columns
      ),
      occupied = current.flatMap((q) =>
        Array.from({ length: q.cell.colSpan }, (_, n) => q.cell.column + n)
      )
    if (spans.length !== 1 || occupied.length !== columns || new Set(occupied).size !== columns)
      continue
    const groups = Array.from({ length: columns }, () => [])
    let bad = false
    for (const q of current) {
      const ff = q === p ? number : q.fonts
      if (
        !baseline(ff) ||
        ff.some((f) => !near(f.baseline, y) || Math.abs(f.height - h) > h * 0.1)
      ) {
        bad = true
        break
      }
      for (const f of ff) {
        const fits = edges.flatMap((r, n) =>
          f.rect[0] >= r[0] - h * 0.2 && f.rect[2] <= r[1] + h * 0.2 ? [n] : []
        )
        if (
          fits.length !== 1 ||
          fits[0] < q.cell.column ||
          fits[0] >= q.cell.column + q.cell.colSpan
        ) {
          bad = true
          break
        }
        groups[fits[0]].push(f)
      }
    }
    if (
      bad ||
      groups.some((ff) => !ff.length || !point(literal(ff))) ||
      firstKey(allNext[0]) <= lastKey(groups.flat()) ||
      firstKey(allNext[1]) <= lastKey(allNext[0])
    )
      continue
    for (const q of owned.filter(
      (q) =>
        q.cell.row === p.cell.row - 1 &&
        q.cell.column > 0 &&
        q.cell.colSpan === 1 &&
        q.cell.rowSpan === 1 &&
        q.fonts.length === 2 &&
        exact(q)
    )) {
      const [symbol, sub] = q.fonts
      if (
        !/^\p{L}$/u.test(symbol.text) ||
        !/^\p{L}$/u.test(sub.text) ||
        !near(symbol.baseline, label.baseline) ||
        Math.abs(symbol.height - h) > h * 0.1 ||
        label.height < symbol.height * 0.65 ||
        label.height > symbol.height * 1.05 ||
        sub.height <= symbol.height * 0.5 ||
        sub.height >= symbol.height * 0.85 ||
        sub.baseline < symbol.baseline ||
        sub.baseline - symbol.baseline > symbol.height * 0.25 ||
        sub.rect[0] < symbol.rect[2] - h * 0.05 ||
        sub.rect[0] - symbol.rect[2] > h * 0.5
      )
        continue
      const words = [...native.values()].filter(
        (f) =>
          good(f) &&
          f.sourceItem.pageNumber === label.sourceItem.pageNumber &&
          /^\p{L}{2,}$/u.test(f.text) &&
          table.unassigned?.includes(f.text) &&
          !owners.has(key(f.sourceItem)) &&
          near(f.baseline, label.baseline) &&
          f.rect[0] > label.rect[2] &&
          f.rect[0] - label.rect[2] <= h * 0.6 &&
          symbol.rect[0] > f.rect[2] &&
          symbol.rect[0] - f.rect[2] <= h * 0.6
      )
      if (words.length !== 1) continue
      const title = [label, words[0], symbol, sub]
      if (
        title.some((f) => f.sourceItem.pageNumber !== label.sourceItem.pageNumber) ||
        title.some((f, n) => n && f.sourceItem.index <= title[n - 1].sourceItem.index) ||
        firstKey(number) <= lastKey(title)
      )
        continue
      const between = inventory.filter(
        (f) =>
          f.sourceItem?.pageNumber === label.sourceItem.pageNumber &&
          f.sourceItem.index >= firstKey(title) &&
          f.sourceItem.index <= lastKey(title) &&
          f.text?.trim()
      )
      if (
        between.length !== title.length ||
        between.some((f) => !title.includes(f) || native.get(key(f.sourceItem)) !== f)
      )
        continue
      const all = [...title, ...groups.flat(), ...allNext.flat()],
        b = bounds(all),
        pairs = horizontal.flatMap((top) =>
          horizontal
            .filter(
              (bottom) =>
                near(top[0], bottom[0]) &&
                near(top[2], bottom[2]) &&
                top[0] <= b[0] &&
                top[2] >= b[2] &&
                top[1] < b[1] &&
                bottom[1] > b[3] &&
                !horizontal.some(
                  (r) =>
                    near(r[0], top[0]) && near(r[2], top[2]) && r[1] > top[1] && r[1] < bottom[1]
                )
            )
            .map((bottom) => [top, bottom])
        )
      if (pairs.length === 1 && table.cropRect.every((n, i) => (i < 2 ? b[i] >= n : b[i] <= n)))
        return true
    }
  }
  return false
}

// Separate complete native bands can contradict a leaf row only when other
// independent columns and already separated records establish the same break.
// This proves ambiguity; it supplies neither a new grid nor character splits.
function nativeMergedRecordConflicts(table, owned) {
  const result = [],
    leaves = owned.filter((p) => p.cell.rowSpan === 1 && p.cell.colSpan === 1),
    text = (ff) => compact(ff.map((f) => f.text).join('')),
    near = (a, b, h) => Math.abs(a - b) < h * 0.2,
    bands = (p, allowScripts = false) => {
      const h = Math.max(...p.fonts.map((f) => f.height)),
        lines = []
      for (const f of [...p.fonts].sort(
        (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
      )) {
        if (!Number.isFinite(f.baseline)) return []
        if (f.height < h * 0.8) {
          if (allowScripts) continue
          return []
        }
        const last = lines.at(-1)
        if (last && near(last[0].baseline, f.baseline, h * 0.75)) last.push(f)
        else lines.push([f])
      }
      return lines
    },
    aligned = (a, b, h) =>
      [0, 1, 2].some((axis) => {
        const anchor = (ff) => {
          const r = bounds(ff)
          return axis === 1 ? (r[0] + r[2]) / 2 : r[axis]
        }
        return near(anchor(a), anchor(b), h * 2)
      }),
    heads = leaves.filter((p) => p.cell.row === 0),
    body = leaves.filter((p) => p.cell.row > 0),
    headBands = heads.map((p) => ({ p, lines: bands(p, true) }))
  // The first globally printed band is a header, followed by a complete body
  // band in at least three columns. Two other separated records must repeat
  // both a native function-call lane and an exact short literal lane. Paint
  // order is only corroboration: column-major multiline headings are excluded.
  if (
    heads.length === table.grid[0].length &&
    heads.length >= 3 &&
    headBands.every((p) => p.lines.length === 2)
  ) {
    const reference = headBands[0].lines,
      h = reference[0][0].height,
      first = headBands.flatMap((p) => p.lines[0]),
      second = headBands.flatMap((p) => p.lines[1]),
      allFonts = owned.flatMap((p) => p.fonts),
      modes = new Set()
    if (
      reference[1][0].baseline - reference[0][0].baseline >= h &&
      headBands.every((p) =>
        p.lines.every((l, i) => near(l[0].baseline, reference[i][0].baseline, h))
      ) &&
      near(Math.min(...allFonts.map((f) => f.baseline)), reference[0][0].baseline, h) &&
      Math.max(...first.map((f) => f.sourceItem.index)) <
        Math.min(...second.map((f) => f.sourceItem.index))
    ) {
      for (const { p, lines } of headBands) {
        const lower = text(lines[1]),
          upper = text(lines[0]),
          call = lower.match(/^\p{L}{1,8}\(/u)?.[0],
          mode = call ? 'call' : /^[\p{L}\p{N}.-]{1,12}$/u.test(lower) ? 'literal' : null,
          matches = (value) => (call ? value.startsWith(call) : value === lower)
        if (!mode || matches(upper)) continue
        const peers = body.filter((q) => {
          const ll = bands(q, true)
          return (
            q.cell.column === p.cell.column &&
            ll.length === 1 &&
            ll[0][0].baseline > lines[1][0].baseline + h &&
            matches(text(ll[0])) &&
            aligned(ll[0], lines[1], h)
          )
        })
        if (new Set(peers.map((q) => q.cell.row)).size >= 2) modes.add(mode)
      }
      if (modes.has('call') && modes.has('literal'))
        result.push('native-header-and-first-record-merged')
    }
  }
  // Distinct whole stub labels alone can be wrapped prose. Require two complete
  // starts in a second field and a repeated categorical code in a third field,
  // also printed in at least two separate rows under its own aligned heading.
  for (const stub of body.filter((p) => p.cell.column === 0)) {
    const ll = bands(stub),
      h = stub.fonts[0].height
    if (
      ll.length !== 2 ||
      ll.some((l) => l.length !== 1 || !/\p{L}{2}/u.test(l[0].text)) ||
      text(ll[0]) === text(ll[1]) ||
      !near(ll[0][0].rect[0], ll[1][0].rect[0], h) ||
      ll[1][0].baseline - ll[0][0].baseline < h * 2
    )
      continue
    for (const code of body.filter((p) => p.cell.row === stub.cell.row && p.cell.column > 0)) {
      const cc = bands(code),
        heading = heads.find((p) => p.cell.column === code.cell.column)
      if (
        cc.length !== 2 ||
        !/^[\p{L}\p{N}]+(?:[·/:=-][\p{L}\p{N}]+)+$/u.test(text(cc[0])) ||
        text(cc[0]) !== text(cc[1]) ||
        !cc.every((l, i) => near(l[0].baseline, ll[i][0].baseline, h)) ||
        !heading ||
        bands(heading).length !== 1 ||
        heading.box[3] >= stub.box[1] ||
        !aligned(heading.fonts, cc[0], h)
      )
        continue
      const peers = body.filter((p) => {
          const pp = bands(p)
          return (
            p.cell.row !== stub.cell.row &&
            p.cell.column === code.cell.column &&
            pp.length === 1 &&
            text(pp[0]) === text(cc[0]) &&
            aligned(pp[0], cc[0], h)
          )
        }),
        other = body.some((p) => {
          const pp = bands(p)
          return (
            p.cell.row === stub.cell.row &&
            p.cell.column !== 0 &&
            p.cell.column !== code.cell.column &&
            pp.length === 2 &&
            pp.every((l, i) => near(l[0].baseline, ll[i][0].baseline, h))
          )
        })
      if (other && new Set(peers.map((p) => p.cell.row)).size >= 2)
        result.push('native-independent-record-starts-merged')
    }
  }
  return result
}

function nativeLaneContradictions(table, owned, native, owners, horizontal) {
  const conflicts = new Set(),
    leaves = owned.filter((p) => p.cell.rowSpan === 1 && p.cell.colSpan === 1),
    body = leaves.filter((p) => p.cell.row > 0),
    heads = leaves.filter((p) => p.cell.row === 0),
    empty = (c) => !c.text?.trim() && !c.sourceItems?.length && !c.sourceSegments?.length,
    fullLine = (fonts) =>
      fonts.length &&
      fonts.every(
        (f) =>
          Number.isFinite(f.baseline) &&
          Math.abs(f.baseline - fonts[0].baseline) < fonts[0].height * 0.15 &&
          f.height > fonts[0].height * 0.8
      ),
    divided = (header, fonts) =>
      horizontal.some(
        (r) =>
          r[0] <= Math.min(header[0], ...fonts.map((f) => f.rect[0])) + 0.02 &&
          r[2] >= Math.max(header[2], ...fonts.map((f) => f.rect[2])) - 0.02 &&
          r[1] > header[3] &&
          r[1] < Math.min(...fonts.map((f) => f.rect[1]))
      )
  const multiline = (p) => {
    const ordered = [...p.fonts].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
      h = Math.max(...ordered.map((f) => f.height)),
      lines = []
    if (ordered.some((f) => !Number.isFinite(f.baseline) || f.height < h * 0.8)) return []
    for (const f of ordered) {
      const last = lines.at(-1)
      if (last && Math.abs(last[0].baseline - f.baseline) < h * 0.15) last.push(f)
      else lines.push([f])
    }
    return lines.slice(1).some((line, i) => line[0].baseline - lines[i][0].baseline < h * 0.9)
      ? []
      : lines
  }
  // Two numeric lanes alone can be multiline values. Independently labelled
  // records, repeated inside two printed bands, establish the missing rows.
  let labelledBands = 0
  for (const row of new Set(body.map((p) => p.cell.row))) {
    const peers = body.filter((p) => p.cell.row === row),
      multi = peers.map((p) => ({ ...p, lines: multiline(p) })).filter((p) => p.lines.length >= 2)
    for (const label of multi) {
      const text = label.lines.map((line) => line.map((f) => f.text.trim()).join('')),
        h = label.fonts[0].height
      if (!text.every((s) => /^\p{L}+$/u.test(s)) || new Set(text).size !== text.length) continue
      const numeric = multi.filter(
        (p) =>
          p !== label &&
          p.lines.length === label.lines.length &&
          p.lines.every(
            (line, i) =>
              Math.abs(line[0].baseline - label.lines[i][0].baseline) < h * 0.15 &&
              /^[+−-]?\d+(?:[.,]\d+)?%?$/u.test(line.map((f) => f.text.trim()).join(''))
          )
      )
      if (numeric.length < 2) continue
      const r = bounds([label, ...numeric].flatMap((p) => p.fonts)),
        top = horizontal.filter((s) => s[0] <= r[0] && s[2] >= r[2] && s[1] < r[1]),
        bottom = horizontal.filter((s) => s[0] <= r[0] && s[2] >= r[2] && s[1] > r[3])
      if (
        top.some((s) => r[1] - s[1] < h) &&
        bottom.some((s) => s[1] - r[3] < h) &&
        !peers.some((p) => p.cell.sourceSegments?.length)
      ) {
        labelledBands++
        break
      }
    }
  }
  if (labelledBands >= 2) conflicts.add('labelled-numeric-records-collapsed')

  // Two individually underlined child spans give an independent meaning to a
  // higher underline. A section title or an unruled centered word is not enough.
  for (const top of owned.filter((p) => p.cell.row === 0 && fullLine(p.fonts))) {
    const h = top.fonts[0].height
    const bars = horizontal.filter(
      (r) => r[0] <= top.box[0] && r[2] >= top.box[2] && r[1] > top.box[3] && r[1] - top.box[3] < h
    )
    if (bars.length !== 1) continue
    const bar = bars[0]
    const children = owned.filter((p) => {
      if (
        p.cell.row !== 1 ||
        p.cell.colSpan < 2 ||
        !fullLine(p.fonts) ||
        p.box[0] < bar[0] ||
        p.box[2] > bar[2] ||
        p.box[1] < bar[1]
      )
        return false
      const under = horizontal.filter(
        (r) =>
          r[0] >= bar[0] - 0.01 &&
          r[2] <= bar[2] + 0.01 &&
          r[0] <= p.box[0] &&
          r[2] >= p.box[2] &&
          r[1] > p.box[3] &&
          r[1] - p.box[3] < h
      )
      return (
        under.length === 1 &&
        Array.from({ length: p.cell.colSpan }, (_, i) => p.cell.column + i).every(
          (column) =>
            body.filter(
              (q) =>
                q.cell.row > 1 &&
                q.cell.column === column &&
                (q.box[0] + q.box[2]) / 2 >= under[0][0] &&
                (q.box[0] + q.box[2]) / 2 <= under[0][2]
            ).length >= 2
        )
      )
    })
    if (
      children.length !== 2 ||
      children[0].box[2] >= children[1].box[0] ||
      children[0].cell.column + children[0].cell.colSpan !== children[1].cell.column ||
      Math.abs(children[0].box[3] - children[1].box[3]) > h * 0.15
    )
      continue
    const first = Math.min(...children.map((p) => p.cell.column)),
      last = Math.max(...children.map((p) => p.cell.column + p.cell.colSpan))
    if (top.cell.column > first || top.cell.column + top.cell.colSpan < last)
      conflicts.add('native-parent-group-span')
  }

  // An unknown native atom in a closed source-order/advance gap cannot simply
  // disappear from a mapped formula. Keep its literal; never guess Unicode.
  for (const f of native.values()) {
    if (
      !f ||
      !(
        f.text.length === 1 &&
        (f.text.charCodeAt(0) <= 8 || (f.text.charCodeAt(0) >= 14 && f.text.charCodeAt(0) <= 31))
      ) ||
      !(table.unassigned ?? []).includes(f.text) ||
      owners.has(key(f.sourceItem)) ||
      !(f.rect[2] > f.rect[0]) ||
      !(f.rect[3] > f.rect[1])
    )
      continue
    // PDF.js may keep whitespace-only native items between the painted atoms.
    // Those are absent from this inventory; use the adjacent nonempty native
    // owners only when their advance and ink bounds independently close the
    // gap. A nearby unknown glyph without that closed gap proves nothing.
    const stream = [...native.values()]
        .filter((g) => g && g.sourceItem.pageNumber === f.sourceItem.pageNumber)
        .sort((a, b) => a.sourceItem.index - b.sourceItem.index),
      at = stream.indexOf(f),
      preceding = stream[at - 1],
      following = stream[at + 1]
    if (
      preceding &&
      following &&
      owned.some((p) => /[=∼<>≤≥]/u.test(p.cell.text)) &&
      owned.some((p) => p.fonts.includes(preceding) && p.fonts.includes(following))
    ) {
      const h = Math.min(preceding.height, following.height, f.height)
      if (
        f.rect[0] >= preceding.rect[2] - h * 0.01 &&
        f.rect[0] - preceding.rect[2] < h * 0.3 &&
        Math.abs(f.rect[2] - following.rect[0]) < h * 0.01 &&
        Math.abs(preceding.baseline - following.baseline) < h * 0.1 &&
        f.rect[3] > Math.max(preceding.rect[1], following.rect[1]) &&
        f.rect[1] < Math.min(preceding.rect[3], following.rect[3])
      )
        conflicts.add('unassigned-native-formula-atom')
    }
    for (const p of owned) {
      if (!/[=∼<>≤≥]/u.test(p.cell.text)) continue
      const left = p.fonts.find(
          (g) =>
            g.sourceItem.index === f.sourceItem.index - 1 &&
            g.sourceItem.pageNumber === f.sourceItem.pageNumber
        ),
        right = p.fonts.find(
          (g) =>
            g.sourceItem.index === f.sourceItem.index + 1 &&
            g.sourceItem.pageNumber === f.sourceItem.pageNumber
        )
      if (!left || !right) continue
      const h = Math.min(left.height, right.height, f.height)
      if (
        Math.abs(f.rect[0] - left.rect[2]) < h * 0.01 &&
        Math.abs(f.rect[2] - right.rect[0]) < h * 0.01 &&
        Math.abs(left.baseline - right.baseline) < h * 0.1 &&
        f.rect[3] > left.rect[1] &&
        f.rect[1] < left.rect[3]
      )
        conflicts.add('unassigned-native-formula-atom')
    }
  }

  // A header and three record starts must independently agree on a detached
  // numeric edge and an empty gutter. This excludes ordinary numbered prose.
  for (const leading of [true, false]) {
    const col = leading ? 0 : table.grid[0].length - 1
    for (const head of heads.filter((p) => p.cell.column === col && p.fonts.length >= 2)) {
      const ordered = [...head.fonts].sort((a, b) => a.rect[0] - b.rect[0]),
        label = leading ? ordered[0] : ordered.at(-1),
        other = ordered.filter((f) => f !== label),
        h = label.height
      if (!/^\p{L}{2,32}$/u.test(label.text.trim()) || !fullLine(head.fonts)) continue
      const lane = body
        .filter((p) => p.cell.column === col)
        .flatMap((p) => {
          const matches = p.fonts.filter(
            (f) =>
              /^\d{1,6}$/u.test(f.text.trim()) &&
              Math.abs(
                (leading ? f.rect[0] : f.rect[2]) - (leading ? label.rect[0] : label.rect[2])
              ) <
                h * 0.1
          )
          if (matches.length !== 1 || p.fonts.length < 3) return []
          const number = matches[0],
            rest = p.fonts.filter((f) => f !== number)
          if (
            Math.abs(number.baseline - Math.min(...rest.map((f) => f.baseline))) > h * 0.15 ||
            !body.some(
              (q) =>
                q.cell.row === p.cell.row &&
                q.cell.column !== col &&
                q.fonts.some((f) => Math.abs(f.baseline - number.baseline) < h * 0.15)
            )
          )
            return []
          return [{ p, number, rest }]
        })
      if (lane.length < 3) continue
      const numbers = [label, ...lane.map((p) => p.number)],
        prose = [...other, ...lane.flatMap((p) => p.rest)],
        gapLeft = Math.max(...(leading ? numbers : prose).map((f) => f.rect[2])),
        gapRight = Math.min(...(leading ? prose : numbers).map((f) => f.rect[0]))
      if (
        gapRight - gapLeft <= h * 0.8 ||
        !divided(
          head.box,
          lane.flatMap((p) => p.p.fonts)
        )
      )
        continue
      if (
        [...native.values()].some(
          (f) =>
            f &&
            f.text.trim() &&
            f.rect[0] < gapRight &&
            f.rect[2] > gapLeft &&
            f.rect[1] >= head.box[1] &&
            f.rect[3] <= Math.max(...lane.map((p) => p.p.box[3]))
        )
      )
        continue
      conflicts.add('independent-headed-native-lane')
    }
  }

  for (const head of heads.filter((p) => fullLine(p.fonts))) {
    const next = heads.find((p) => p.cell.column === head.cell.column + 1),
      h = head.fonts[0].height
    if (!next || Math.abs(head.box[3] - next.box[3]) > h * 1.5 || head.box[2] >= next.box[0])
      continue
    const emptyRows = table.cells.filter(
      (c) =>
        c.row > 0 && c.column === head.cell.column && c.rowSpan === 1 && c.colSpan === 1 && empty(c)
    )
    const crossing = emptyRows.flatMap((c) => {
      const p = body.find((q) => q.cell.row === c.row && q.cell.column === next.cell.column)
      if (!p || p.fonts.length !== 1) return []
      const f = p.fonts[0],
        left = (head.box[0] + head.box[2]) / 2,
        right = (next.box[0] + next.box[2]) / 2
      return f.rect[0] < left - h * 0.5 && f.rect[2] > right && /^\d+\s+\S/u.test(f.text) ? [p] : []
    })
    if (
      crossing.length >= 3 &&
      !body.some((p) => p.cell.column === head.cell.column) &&
      divided(
        bounds([...head.fonts, ...next.fonts]),
        crossing.flatMap((p) => p.fonts)
      )
    )
      conflicts.add('native-run-crosses-empty-leaf')
  }

  // Touching high-band formula atoms cannot be independent leaf headings when
  // both cells also own lower, separately aligned labels and two body records.
  for (const a of heads)
    for (const b of heads) {
      if (b.cell.column !== a.cell.column + 1) continue
      for (const f of a.fonts)
        for (const g of b.fonts) {
          const h = Math.max(f.height, g.height)
          if (
            !/[\p{L}\p{N}∑∆×⟨|]/u.test(f.text + g.text) ||
            Math.abs(f.rect[2] - g.rect[0]) > h * 0.01 ||
            Math.abs(f.baseline - g.baseline) > h * 0.6 ||
            ![a, b].every((p) =>
              p.fonts.some((t) => t.rect[1] > Math.max(f.rect[3], g.rect[3]) + h * 0.3)
            ) ||
            ![a, b].every((p) => body.filter((q) => q.cell.column === p.cell.column).length >= 2) ||
            !divided(
              bounds([...a.fonts, ...b.fonts]),
              body
                .filter((p) => p.cell.column === a.cell.column || p.cell.column === b.cell.column)
                .flatMap((p) => p.fonts)
            )
          )
            continue
          conflicts.add('native-math-group-split')
        }
    }
  return [...conflicts]
}

const nearNative = (a, b, h) => Math.abs(a - b) < h * 0.1
const nativeScalar = (s) => /^[+−-]?\d+(?:\.\d+)?$/u.test(s.trim())
const nativeInterval = (s) =>
  /^\[\s*[+−-]?\d+(?:\.\d+)?\s*,\s*[+−-]?\d+(?:\.\d+)?\s*\]$/u.test(s.trim())
const fontKey = (f) => key(f.sourceItem)
const canonicalNativeFont = (f) =>
  f &&
  Number.isSafeInteger(f.sourceItem?.index) &&
  f.sourceItem.index >= 0 &&
  f.horizontal &&
  rect(f.rect) &&
  f.height > 0 &&
  Number.isFinite(f.baseline) &&
  f.text === f.sourceItem.text
// Native label bounds are usable only when they reproduce the original metrics.
function verifiedNativeLabelRect(f) {
  const r = f.nativeLabelRect
  return rect(r) &&
    Number.isFinite(f.fontAscent) &&
    f.fontAscent > 0 &&
    same(r, [
      f.rect[0],
      f.baseline - f.fontAscent * f.height,
      f.rect[2],
      f.baseline - f.fontAscent * f.height + f.height
    ])
    ? r
    : undefined
}

// Independently closed native faces can contradict the proposed grid. This produces
// no grid, row assignment, source range, merged cell, or replacement text.
function nativeClosedFaceContradictions(table, provedOwners, native, counts, rules) {
  if (!table?.cells?.length || !rect(table.cropRect)) return []
  const proved = provedOwners.filter((p) => p.cell.colSpan === 1 && p.cell.rowSpan === 1)
  const body = proved.filter((p) => p.cell.row > 0)
  if (!body.length) return []
  const b = bounds(body.flatMap((p) => p.fonts)),
    horizontal = rules.filter((r) => rect(r) && r[1] === r[3] && r[2] > r[0]),
    vertical = rules.filter((r) => rect(r) && r[0] === r[2] && r[3] > r[1])
  const xs = clusterTableRulePositions(vertical.map((r) => r[0])),
    left = xs.filter((x) => x <= b[0]).at(-1),
    right = xs.find((x) => x >= b[2])
  if (!Number.isFinite(left) || !Number.isFinite(right) || left >= right) return []
  const ys = clusterTableRulePositions(
    horizontal
      .filter((r) => r[1] >= table.cropRect[1] && r[1] <= table.cropRect[3])
      .map((r) => r[1])
  ).filter((y) => classifyTableRuleEdge(horizontal, 1, y, left, right) === 1)
  const faces = []
  for (let i = 1; i < ys.length; i++) {
    const top = ys[i - 1],
      bottom = ys[i]
    if (
      classifyTableRuleEdge(vertical, 0, left, top, bottom) !== 1 ||
      classifyTableRuleEdge(vertical, 0, right, top, bottom) !== 1
    )
      continue
    const fonts = [...native.values()].filter(
      (f) =>
        f &&
        f.text.trim() &&
        f.baseline > top &&
        f.baseline < bottom &&
        f.rect[0] >= left &&
        f.rect[2] <= right
    )
    if (
      !fonts.length ||
      fonts.some(
        (f) =>
          (verifiedNativeLabelRect(f) ?? f.rect)[1] <= top ||
          (verifiedNativeLabelRect(f) ?? f.rect)[3] >= bottom
      )
    )
      continue
    const own = proved.filter((p) => p.fonts.every((f) => fonts.includes(f))),
      rows = [...new Set(own.map((p) => p.cell.row))].sort((a, b) => a - b)
    const allMapped = fonts.every((f) => own.some((p) => p.fonts.includes(f))),
      columns = [...new Set(own.map((p) => p.cell.column))]
    const missing = fonts.every(
      (f) => !counts.has(fontKey(f)) && (table.unassigned ?? []).includes(f.text)
    )
    faces.push({
      top,
      bottom,
      left,
      right,
      fonts,
      owners: own,
      rows,
      columns,
      complete: allMapped && rows.length === 1 && columns.length >= 2,
      missing
    })
  }
  const complete = faces.filter((f) => f.complete && f.rows[0] > 0),
    conflicts = []
  if (complete.length >= 2) {
    for (const face of faces) {
      if (
        face.missing &&
        face.fonts.length >= 2 &&
        complete.some((p) => p.bottom <= face.top) &&
        complete.some((p) => p.top >= face.bottom)
      ) {
        const lanes = new Set(
          face.fonts
            .map((f) =>
              complete
                .flatMap((p) => p.owners)
                .filter((p) => f.rect[0] >= p.box[0] - f.height * 0.1 && f.rect[0] <= p.box[2])
                .map((p) => p.cell.column)
            )
            .flat()
        )
        if (lanes.size >= 2) conflicts.push('unassigned-closed-native-record')
      }
      if (
        face.rows.length === 2 &&
        face.rows[1] === face.rows[0] + 1 &&
        face.owners.some((p) => p.cell.row === face.rows[0] && p.cell.column === 0) &&
        !face.owners.some((p) => p.cell.row === face.rows[1] && p.cell.column === 0) &&
        new Set(face.owners.filter((p) => p.cell.row === face.rows[1]).map((p) => p.cell.column))
          .size >= 2 &&
        complete.filter((p) => p.bottom <= face.top).length >= 2
      )
        conflicts.push('closed-record-face-split-across-rows')
    }
  }
  return [...new Set(conflicts)]
}

// Supplement an existing exact native-owner proof. No label is reassigned.
function nativeLabelSourceBlockConflicts(table, owned, bySource, claims, rules) {
  const conflicts = []
  const source = [...bySource.values()].filter(
      (f) => f && f.horizontal && f.height > 0 && Number.isFinite(f.baseline) && f.text.trim()
    ),
    leaf = owned.filter((p) => p.cell.colSpan === 1 && p.cell.rowSpan === 1)
  const numericPeers = (p) =>
    leaf.filter(
      (q) =>
        q.cell.row === p.cell.row &&
        q.cell.column > p.cell.column &&
        q.fonts.length === 1 &&
        nativeScalar(q.cell.text) &&
        nearNative(q.fonts[0].baseline, p.fonts[0].baseline, p.fonts[0].height)
    )
  const consecutive = (a, b) =>
    a.sourceItem.pageNumber === b.sourceItem.pageNumber &&
    b.sourceItem.index === a.sourceItem.index + 1
  const completeBlocks = leaf.flatMap((p) => {
    const ff = [...p.fonts].sort((a, b) => a.baseline - b.baseline),
      h = ff[0].height,
      peers = numericPeers(p)
    if (
      ff.length < 2 ||
      peers.length < 2 ||
      ff.some((f) => !nearNative(f.rect[0], ff[0].rect[0], h) || !nearNative(f.height, h, h)) ||
      ff.slice(1).some((f, i) => !consecutive(ff[i], f))
    )
      return []
    const step = ff[1].baseline - ff[0].baseline
    if (
      step <= h ||
      step >= h * 1.5 ||
      ff.slice(1).some((f, i) => !nearNative(f.baseline - ff[i].baseline, step, h))
    )
      return []
    const after = source
      .filter(
        (f) =>
          f.sourceItem.pageNumber === ff[0].sourceItem.pageNumber &&
          f.sourceItem.index > ff.at(-1).sourceItem.index
      )
      .sort((a, b) => a.sourceItem.index - b.sourceItem.index)[0]
    if (
      !after ||
      !leaf.some(
        (q) =>
          q.cell.row === p.cell.row &&
          q.cell.column !== p.cell.column &&
          q.fonts.some((f) => fontKey(f) === fontKey(after))
      ) ||
      peers.some((q) => q.fonts[0].sourceItem.index <= ff.at(-1).sourceItem.index)
    )
      return []
    return [{ p, fonts: ff, step, h }]
  })
  for (const p of leaf.filter((p) => p.cell.row > 0)) {
    const ff = [...p.fonts].sort((a, b) => a.baseline - b.baseline),
      head = ff.at(-1),
      h = head.height,
      peers = numericPeers(p)
    if (
      peers.length < 2 ||
      ff.some((f) => !nearNative(f.rect[0], head.rect[0], h) || !nearNative(f.height, h, h))
    )
      continue
    const tail = bySource.get(`${head.sourceItem.pageNumber}:${head.sourceItem.index + 1}`)
    if (
      !tail ||
      !tail.horizontal ||
      !nearNative(tail.height, h, h) ||
      !nearNative(tail.rect[0], head.rect[0], h) ||
      tail.baseline <= head.baseline + h ||
      tail.baseline >= head.baseline + h * 1.5 ||
      claims.get(fontKey(tail)) > 1 ||
      p.fonts.some((f) => fontKey(f) === fontKey(tail))
    )
      continue
    if (
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > head.baseline &&
          r[1] < tail.baseline &&
          r[0] <= Math.min(head.rect[0], tail.rect[0]) &&
          r[2] >= Math.max(head.rect[2], tail.rect[2])
      )
    )
      continue
    const after = source
      .filter(
        (f) =>
          f.sourceItem.pageNumber === head.sourceItem.pageNumber &&
          f.sourceItem.index > tail.sourceItem.index
      )
      .sort((a, b) => a.sourceItem.index - b.sourceItem.index)[0]
    if (
      !after ||
      !leaf.some(
        (q) =>
          q.cell.row === p.cell.row &&
          q.cell.column !== p.cell.column &&
          q.fonts.some((f) => fontKey(f) === fontKey(after))
      ) ||
      peers.some((q) => q.fonts[0].sourceItem.index <= tail.sourceItem.index)
    )
      continue
    const witnesses = completeBlocks.filter(
      (w) =>
        w.p.cell.row !== p.cell.row &&
        w.p.cell.column === p.cell.column &&
        nearNative(w.fonts[0].rect[0], head.rect[0], h) &&
        nearNative(w.h, h, h) &&
        nearNative(w.step, tail.baseline - head.baseline, h)
    )
    const literalWitness = witnesses.some(
      (w) =>
        w.fonts.map((f) => f.text).join(' ') === ff.map((f) => f.text).join(' ') + ' ' + tail.text
    )
    if (!literalWitness && witnesses.length < 2) continue
    if (!claims.has(fontKey(tail)) && !(table.unassigned ?? []).includes(tail.text)) continue
    conflicts.push('native-label-source-block-split')
  }
  return [...new Set(conflicts)]
}

function nativeHeaderLaneConflicts(table, owned, source, counts, inventory, rules) {
  const heads = table.cells
    .filter((c) => c.row === 0 && c.rowSpan === 1 && c.colSpan === 1)
    .flatMap((c) => {
      if (!c.sourceItems?.length || c.sourceSegments?.length || !c.sourceRects?.length) return []
      const fonts = c.sourceItems.map((s) => source.get(`${s.pageNumber}:${s.index}`))
      if (
        fonts.some(
          (f, i) => !f || counts.get(fontKey(f)) !== 1 || f.text !== c.sourceItems[i].text
        ) ||
        compact(fonts.map((f) => f.text).join('')) !== compact(c.text)
      )
        return []
      const ranges = fonts.map(() => [])
      for (const r of c.sourceRects) {
        if (!rect(r)) return []
        const owners = fonts.flatMap((f, i) =>
          r[0] >= f.rect[0] - 1e-6 &&
          r[1] >= f.rect[1] - 1e-6 &&
          r[2] <= f.rect[2] + 1e-6 &&
          r[3] <= f.rect[3] + 1e-6
            ? [i]
            : []
        )
        if (owners.length !== 1) return []
        ranges[owners[0]].push({ rect: r })
      }
      if (
        fonts.some(
          (f, i) =>
            !ranges[i].length ||
            !same(bounds(ranges[i]), f.rect) ||
            ranges[i].some((a, j) =>
              ranges[i]
                .slice(j + 1)
                .some((b) => Math.min(a.rect[2], b.rect[2]) > Math.max(a.rect[0], b.rect[0]) + 1e-6)
            )
        )
      )
        return []
      return [{ cell: c, fonts, box: bounds(fonts) }]
    })
  const body = owned.filter((p) => p.cell.row > 0 && p.cell.rowSpan === 1 && p.cell.colSpan === 1),
    horizontal = rules.filter(
      (r) => rect(r) && r[1] === r[3] && r[1] >= table.cropRect[1] && r[1] <= table.cropRect[3]
    ),
    conflicts = []
  const enclosed = (ff) => {
    const b = bounds(ff)
    return (
      horizontal.some((r) => r[0] <= b[0] && r[2] >= b[2] && r[1] < b[1]) &&
      horizontal.some((r) => r[0] <= b[0] && r[2] >= b[2] && r[1] > b[3])
    )
  }
  for (const head of heads) {
    const fonts = [...head.fonts].sort((a, b) => a.rect[0] - b.rect[0])
    if (fonts.length !== 2 || !fonts.every((f) => /\p{L}{2}/u.test(f.text))) continue
    const h = fonts[0].height
    if (
      !nearNative(fonts[0].baseline, fonts[1].baseline, h) ||
      fonts[1].rect[0] - fonts[0].rect[2] <= h
    )
      continue
    const lane = body.filter((p) => p.cell.column === head.cell.column),
      pairs = []
    for (const p of lane) {
      const ff = [...p.fonts].sort((a, b) => a.rect[0] - b.rect[0])
      if (
        ff.length !== 2 ||
        !nativeScalar(ff[0].text) ||
        !nativeInterval(ff[1].text) ||
        !nearNative(ff[0].baseline, ff[1].baseline, h) ||
        ff[1].rect[0] - ff[0].rect[2] <= h
      )
        continue
      pairs.push({ p, fonts: ff })
    }
    if (
      pairs.length < 3 ||
      pairs.length !== lane.length ||
      pairs.some((p) => p.fonts.some((f, i) => !nearNative(f.rect[2], fonts[i].rect[2], h)))
    )
      continue
    const all = [...fonts, ...pairs.flatMap((p) => p.fonts)],
      gap = [
        Math.max(...pairs.map((p) => p.fonts[0].rect[2]), fonts[0].rect[2]),
        Math.min(...pairs.map((p) => p.fonts[1].rect[0]), fonts[1].rect[0])
      ],
      b = bounds(all)
    if (
      gap[1] - gap[0] <= h ||
      !enclosed(all) ||
      inventory.some(
        (f) =>
          f.text.trim() &&
          f.rect[0] < gap[1] &&
          f.rect[2] > gap[0] &&
          f.rect[1] < b[3] &&
          f.rect[3] > b[1]
      )
    )
      continue
    conflicts.push('independently-headed-estimate-interval-lanes')
  }
  const groups = []
  for (const p of heads)
    for (const upper of p.fonts) {
      const lower = p.fonts.filter(
        (f) =>
          f !== upper &&
          nearNative(f.height, upper.height, upper.height) &&
          f.baseline > upper.baseline + upper.height
      )
      if (lower.length !== 1) continue
      const child = lower[0],
        h = upper.height
      const q = heads.find(
        (q) =>
          q !== p &&
          q.cell.column === p.cell.column - 1 &&
          q.fonts.some(
            (f) => nearNative(f.baseline, child.baseline, h) && nearNative(f.height, h, h)
          ) &&
          q.box[0] >= upper.rect[0] - 1e-6 &&
          q.box[2] < child.rect[0] &&
          child.rect[2] <= upper.rect[2]
      )
      if (
        !q ||
        !nearNative(q.box[0], upper.rect[0], h) ||
        !horizontal.some(
          (r) =>
            r[0] <= upper.rect[0] &&
            r[2] >= upper.rect[2] &&
            r[1] > upper.baseline &&
            r[1] < child.baseline
        )
      )
        continue
      const peers = body
        .filter(
          (a) =>
            a.cell.column === q.cell.column && a.fonts.length === 1 && nativeScalar(a.cell.text)
        )
        .flatMap((a) => {
          const b = body.find(
            (b) =>
              b.cell.row === a.cell.row &&
              b.cell.column === p.cell.column &&
              b.fonts.length === 1 &&
              nativeScalar(b.cell.text)
          )
          return b &&
            nearNative(a.fonts[0].baseline, b.fonts[0].baseline, h) &&
            a.box[0] >= q.box[0] - h * 0.1 &&
            a.box[2] < child.rect[0] &&
            b.box[0] >= child.rect[0] - h * 0.1
            ? [{ a, b }]
            : []
        })
      if (peers.length >= 2) groups.push({ p, q, upper, child, peers })
    }
  for (const g of groups)
    if (
      groups.some(
        (o) =>
          o !== g &&
          nearNative(o.upper.baseline, g.upper.baseline, g.upper.height) &&
          nearNative(o.child.baseline, g.child.baseline, g.upper.height) &&
          Math.min(o.upper.rect[2], g.upper.rect[2]) < Math.max(o.upper.rect[0], g.upper.rect[0])
      )
    ) {
      conflicts.push('native-parent-heading-consumed-by-child-leaf')
    }
  return [...new Set(conflicts)]
}

// Reuse the existing exact native-owner resolver. These witnesses only stop an
// unsafe mapping: none returns a replacement cell, range, span or crop.
const nativeOwnerLabelBounds = (fonts) => [
  Math.min(...fonts.map((f) => f.rect[0])),
  Math.min(...fonts.map((f) => f.nativeLabelRect[1])),
  Math.max(...fonts.map((f) => f.rect[2])),
  Math.max(...fonts.map((f) => f.nativeLabelRect[3]))
]
function nativeRemainingOwnershipConflicts(table, owned, native, inventory, rules, wholeBand) {
  const complete = owned
    .filter(
      (p) =>
        compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join('')) &&
        p.fonts.every((f) => verifiedNativeLabelRect(f) && Number.isFinite(f.fontDescent))
    )
    .map((p) => ({ ...p, box: nativeOwnerLabelBounds(p.fonts) }))
  const s = {
    table,
    owned: complete,
    headingOwned: wholeBand.filter(
      (p) =>
        compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join('')) &&
        p.fonts.every((f) => verifiedNativeLabelRect(f) && Number.isFinite(f.fontDescent))
    ),
    native,
    inventory,
    horizontal: rules.filter((r) => rect(r) && r[1] === r[3]),
    vertical: rules.filter((r) => rect(r) && r[0] === r[2])
  }
  return [
    [crossedNativeBars, 'native-dividers-cross-leaf-record'],
    [nativeSourceGroupSpan, 'native-group-span-crosses-source-block'],
    [calibratedRuledStub, 'native-calibrated-ruled-stub-span'],
    [closedLeafFaceSplit, 'native-closed-leaf-face-split'],
    [closedHeaderEmptyLane, 'native-run-crosses-empty-leaf'],
    [centeredSourceTail, 'native-label-source-block-split'],
    [calibratedSourceCycles, 'native-calibrated-source-cycles-merged'],
    [calibratedHeadingLane, 'native-heading-assigned-to-foreign-lane']
  ].flatMap(([prove, tag]) => (prove(s).length ? [tag] : []))
}

// Complete native column cycles can contradict a prose repair that joined
// independent records. Require unchanged whole owners, a closed ruled header,
// exclusive full-font bounds and two independently complete model records.
// This only stops the proposed mapping; it never constructs replacement rows.
function calibratedHeadingLane(s) {
  const t = s.table,
    n = t.grid[0].length,
    owned = s.headingOwned,
    populated = t.cells.filter((c) => c.text.trim())
  if (
    n < 3 ||
    owned.length !== populated.length ||
    owned.some(
      (p) =>
        p.cell.rowSpan !== 1 ||
        p.cell.colSpan !== 1 ||
        compact(p.cell.text) !== compact(p.fonts.map((f) => f.text).join(''))
    ) ||
    new Set(t.cells.map((c) => `${c.row}:${c.column}`)).size !== t.cells.length
  )
    return []
  const body = owned.filter((p) => p.cell.row > 0),
    rows = [...new Set(body.map((p) => p.cell.row))].sort((a, b) => a - b)
  if (
    rows.length < 3 ||
    rows.some((r, i) => r !== i + 1) ||
    rows.some((row) => {
      const pp = body.filter((p) => p.cell.row === row)
      return (
        pp.length !== n ||
        new Set(pp.map((p) => p.cell.column)).size !== n ||
        pp.some(
          (p) => !Number.isSafeInteger(p.cell.column) || p.cell.column < 0 || p.cell.column >= n
        )
      )
    })
  )
    return []
  const lanes = Array.from({ length: n }, (_, c) =>
      nativeOwnerLabelBounds(body.filter((p) => p.cell.column === c).flatMap((p) => p.fonts))
    ),
    all = nativeOwnerLabelBounds(body.flatMap((p) => p.fonts)),
    heads = owned.filter((p) => p.cell.row === 0)
  if (!heads.length || lanes.some((b, c) => c && b[0] <= lanes[c - 1][2])) return []
  const hb = nativeOwnerLabelBounds(heads.flatMap((p) => p.fonts)),
    full = s.horizontal.filter(
      (r) => r[0] <= all[0] && r[2] >= all[2] && r[1] > t.cropRect[1] && r[1] < t.cropRect[3]
    )
  if (
    !full.some((r) => r[1] < hb[1]) ||
    !full.some((r) => r[1] > hb[3] && r[1] < all[1]) ||
    !full.some((r) => r[1] > all[3]) ||
    !nativeExclusiveOwnerBand(
      s,
      owned.flatMap((p) => p.fonts),
      [all[0], hb[1], all[2], all[3]]
    )
  )
    return []
  const out = []
  for (const head of heads) {
    if (head.fonts.length !== 1) continue
    const f = head.fonts[0],
      h = f.height
    if (
      body.some((p) => Math.abs(Math.max(...p.fonts.map((g) => g.height)) - h) > h * 0.05) ||
      body.some((p) => p.fonts.some((g) => g.sourceItem.index <= f.sourceItem.index))
    )
      continue
    const matches = lanes.flatMap((b, c) =>
      f.nativeLabelRect[0] >= b[0] - 1e-6 && f.nativeLabelRect[2] <= b[2] ? [c] : []
    )
    if (matches.length === 1 && matches[0] !== head.cell.column) out.push(head)
  }
  return out
}

function calibratedSourceCycles(s) {
  const t = s.table,
    n = t.grid[0].length,
    cells = s.owned,
    exact = (a, b) => Math.abs(a - b) < 1e-6
  if (
    n < 2 ||
    n > 6 ||
    t.grid.some((r) => r.length !== n) ||
    cells.length !== t.cells.length ||
    cells.length !== t.grid.length * n ||
    cells.some(
      (p) =>
        p.cell.rowSpan !== 1 ||
        p.cell.colSpan !== 1 ||
        compact(p.cell.text) !==
          compact(
            [...p.fonts]
              .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
              .map((f) => f.text)
              .join('')
          )
    )
  )
    return []
  const rows = [...new Set(cells.map((p) => p.cell.row))].sort((a, b) => a - b)
  if (
    rows.length !== t.grid.length ||
    rows.some((r, i) => r !== i) ||
    rows.some((row) => {
      const cc = cells.filter((p) => p.cell.row === row).map((p) => p.cell.column)
      return (
        cc.length !== n ||
        new Set(cc).size !== n ||
        cc.some((c) => !Number.isSafeInteger(c) || c < 0 || c >= n)
      )
    })
  )
    return []
  const head = cells.filter((p) => p.cell.row === 0).sort((a, b) => a.cell.column - b.cell.column),
    body = cells.filter((p) => p.cell.row > 0),
    ff = cells.flatMap((p) => p.fonts),
    h = head[0]?.fonts[0]?.height
  if (
    !body.length ||
    head.length !== n ||
    head.some((p) => p.fonts.length !== 1) ||
    ff.some((f) => f.sourceItem.pageNumber !== t.page || Math.abs(f.height - h) > h * 0.05) ||
    head.some((p) => !exact(p.fonts[0].baseline, head[0].fonts[0].baseline))
  )
    return []
  const all = nativeOwnerLabelBounds(ff),
    lanes = Array.from({ length: n }, (_, c) =>
      nativeOwnerLabelBounds(cells.filter((p) => p.cell.column === c).flatMap((p) => p.fonts))
    ),
    bb = nativeOwnerLabelBounds(body.flatMap((p) => p.fonts)),
    hb = nativeOwnerLabelBounds(head.flatMap((p) => p.fonts))
  if (
    lanes.some((b, c) => c && b[0] <= lanes[c - 1][2]) ||
    all.some((v, i) => (i < 2 ? v < t.cropRect[i] - 1e-6 : v > t.cropRect[i] + 1e-6)) ||
    !nativeExclusiveOwnerBand(s, ff, t.cropRect)
  )
    return []
  const full = s.horizontal
    .filter(
      (r) =>
        r[0] <= all[0] &&
        r[2] >= all[2] &&
        r[1] >= t.cropRect[1] - 1e-6 &&
        r[1] <= t.cropRect[3] + 1e-6
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    !exact(full[0][1], t.cropRect[1]) ||
    !exact(full[2][1], t.cropRect[3]) ||
    !(full[0][1] < hb[1] && full[1][1] > hb[3] && full[1][1] < bb[1] && full[2][1] > bb[3])
  )
    return []
  const entries = body
      .flatMap((p) => p.fonts.map((f) => ({ f, row: p.cell.row, lane: p.cell.column })))
      .sort((a, b) => a.f.sourceItem.index - b.f.sourceItem.index),
    groups = []
  let last = -1
  for (const e of entries) {
    if (e.lane === 0 && last === n - 1) last = -1
    if (last === -1) {
      if (e.lane !== 0) return []
      groups.push([])
    }
    if (e.lane < last || e.lane > last + 1) return []
    groups.at(-1).push(e)
    last = e.lane
  }
  if (
    last !== n - 1 ||
    groups.length < 4 ||
    head.some((p) => p.fonts[0].sourceItem.index >= entries[0].f.sourceItem.index)
  )
    return []
  const records = []
  for (const g of groups) {
    const fields = Array.from({ length: n }, (_, c) => g.filter((e) => e.lane === c))
    if (fields.some((f) => !f.length) || new Set(g.map((e) => e.row)).size !== 1) return []
    const starts = fields.map((f) => f[0].f.baseline),
      b = nativeOwnerLabelBounds(g.map((e) => e.f))
    if (
      starts.some((v) => !exact(v, starts[0])) ||
      fields.some((f) =>
        f.some((e, i) => i && e.f.nativeLabelRect[1] <= f[i - 1].f.nativeLabelRect[3])
      ) ||
      (records.length && records.at(-1).bounds[3] >= b[1])
    )
      return []
    records.push({ row: g[0].row, bounds: b })
  }
  const counts = rows.slice(1).map((row) => records.filter((g) => g.row === row).length)
  return counts.some((c) => !c) ||
    counts.filter((c) => c === 1).length < 2 ||
    !counts.some((c) => c > 1)
    ? []
    : records
}
const nativeSingleOwnerLine = (p) =>
  p.fonts.every(
    (f) =>
      Math.abs(f.baseline - p.fonts[0].baseline) < f.height * 0.1 &&
      Math.abs(f.height - p.fonts[0].height) < f.height * 0.1
  )
const nativeExclusiveOwnerBand = (s, ff, b) =>
  s.inventory.every((f) => {
    const r = f.nativeLabelRect ?? f.rect
    return (
      !f.text.trim() ||
      (Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        (r[2] <= b[0] || r[0] >= b[2] || r[3] <= b[1] || r[1] >= b[3])) ||
      ff.includes(f)
    )
  })
function crossedNativeBars(s) {
  const out = []
  for (const r of s.horizontal) {
    const owners = s.owned.filter(
      (p) =>
        p.cell.rowSpan === 1 &&
        p.cell.colSpan === 1 &&
        p.fonts.some((f) => f.nativeLabelRect[3] < r[1]) &&
        p.fonts.some((f) => f.nativeLabelRect[1] > r[1]) &&
        r[0] <= p.box[0] &&
        r[2] >= p.box[2]
    )
    for (const row of new Set(owners.map((p) => p.cell.row))) {
      const cells = owners.filter((p) => p.cell.row === row)
      if (
        cells.length >= 2 &&
        nativeExclusiveOwnerBand(
          s,
          cells.flatMap((p) => p.fonts),
          nativeOwnerLabelBounds(cells.flatMap((p) => p.fonts))
        )
      )
        out.push({ rule: r, row, cells: cells.map((p) => [p.cell.row, p.cell.column]) })
    }
  }
  return out.length >= 2 ? out : []
}
function nativeSourceGroupSpan(s) {
  if (s.table.issues?.some((issue) => issue !== 'unassigned-source-text')) return []
  const out = [],
    labels = s.owned
      .filter((p) => p.cell.column === 0 && p.cell.row > 0)
      .sort(
        (a, b) =>
          Math.min(...a.fonts.map((f) => f.sourceItem.index)) -
          Math.min(...b.fonts.map((f) => f.sourceItem.index))
      )
  if (labels.length < 3) return out
  for (let i = 0; i < labels.length - 1; i++) {
    const p = labels[i],
      next = labels[i + 1],
      h = Math.max(...p.fonts.map((f) => f.height)),
      begin = Math.max(...p.fonts.map((f) => f.sourceItem.index)),
      end = Math.min(...next.fonts.map((f) => f.sourceItem.index))
    const peers = s.owned.filter(
        (q) =>
          q.cell.column > 0 &&
          q.cell.rowSpan === 1 &&
          q.cell.colSpan === 1 &&
          nativeSingleOwnerLine(q) &&
          q.fonts.every((f) => f.sourceItem.index > begin && f.sourceItem.index < end)
      ),
      rows = [...new Set(peers.map((q) => q.cell.row))].sort((a, b) => a - b)
    if (rows.length < 3 || rows.some((r, j) => j && r !== rows[j - 1] + 1)) continue
    const rowPeers = rows.map((row) => peers.filter((p) => p.cell.row === row)),
      columns = rowPeers[0].map((p) => p.cell.column).sort((a, b) => a - b)
    if (
      columns.length < 3 ||
      new Set(columns).size !== columns.length ||
      rowPeers.some(
        (pp) =>
          pp.length !== columns.length ||
          new Set(pp.map((p) => p.cell.column)).size !== columns.length ||
          pp.some((p) => !columns.includes(p.cell.column)) ||
          pp.some((p) => Math.abs(p.fonts[0].baseline - pp[0].fonts[0].baseline) > h * 0.1)
      )
    )
      continue
    const ys = rowPeers.map((pp) => pp[0].fonts[0].baseline),
      step = ys[1] - ys[0],
      y = Math.max(...p.fonts.filter((f) => f.height > h * 0.9).map((f) => f.baseline))
    if (
      step <= h ||
      ys.slice(1).some((v, j) => Math.abs(v - ys[j] - step) > h * 0.1) ||
      Math.abs(y - (ys[0] + ys.at(-1)) / 2) > h * 0.1
    )
      continue
    const ff = [...p.fonts, ...peers.flatMap((p) => p.fonts)],
      b = nativeOwnerLabelBounds(ff)
    if (!nativeExclusiveOwnerBand(s, ff, b)) continue
    const mapped = Array.from({ length: p.cell.rowSpan }, (_, j) => p.cell.row + j)
    if (mapped.length !== rows.length || mapped.some((r, j) => r !== rows[j]))
      out.push({
        label: p.cell.text,
        mappedRows: mapped,
        nativeRecordRows: rows,
        sourceRange: [begin, end],
        center: y,
        step
      })
  }
  return out
}
function calibratedRuledStub(s) {
  const bands = [],
    labels = s.owned.filter((p) => p.cell.column === 0 && p.cell.row > 0 && p.cell.colSpan === 1),
    leaf = s.owned.filter(
      (p) =>
        p.cell.column > 0 &&
        p.cell.row > 0 &&
        p.cell.rowSpan === 1 &&
        p.cell.colSpan === 1 &&
        nativeSingleOwnerLine(p)
    )
  for (const label of labels) {
    const top = s.horizontal
        .filter((r) => r[1] < label.box[1] && r[0] <= label.box[0])
        .sort((a, b) => b[1] - a[1])[0],
      bottom = s.horizontal
        .filter((r) => r[1] > label.box[3] && r[0] <= label.box[0])
        .sort((a, b) => a[1] - b[1])[0]
    if (!top || !bottom) continue
    const peers = leaf.filter((p) => p.box[1] > top[1] && p.box[3] < bottom[1]),
      rows = [...new Set(peers.map((p) => p.cell.row))].sort((a, b) => a - b),
      cols = [...new Set(peers.map((p) => p.cell.column))].sort((a, b) => a - b)
    if (
      rows.length < 3 ||
      cols.length < 3 ||
      rows.some((row, j) => j && row !== rows[j - 1] + 1) ||
      rows.some((row) => peers.filter((p) => p.cell.row === row).length !== cols.length) ||
      rows.some(
        (row) =>
          new Set(peers.filter((p) => p.cell.row === row).map((p) => p.cell.column)).size !==
          cols.length
      ) ||
      labels.some((p) => p !== label && p.box[1] > top[1] && p.box[3] < bottom[1])
    )
      continue
    const ff = [...label.fonts, ...peers.flatMap((p) => p.fonts)],
      b = nativeOwnerLabelBounds(ff)
    if (
      top[2] < b[2] ||
      bottom[2] < b[2] ||
      !nativeExclusiveOwnerBand(s, ff, [top[0], top[1], Math.min(top[2], bottom[2]), bottom[1]])
    )
      continue
    const mapped = Array.from({ length: label.cell.rowSpan }, (_, j) => label.cell.row + j),
      matches = mapped.length === rows.length && mapped.every((r, j) => r === rows[j])
    bands.push({ label: label.cell.text, rows, mapped, matches, top, bottom })
  }
  return bands.filter(
    (b) => !b.matches && bands.some((a) => a !== b && a.matches && a.rows.length === b.rows.length)
  )
}
function closedLeafFaceSplit(s) {
  const xs = clusterTableRulePositions(s.vertical.map((r) => r[0])),
    ys = clusterTableRulePositions(
      s.horizontal
        .filter((r) => r[1] >= s.table.cropRect[1] && r[1] <= s.table.cropRect[3])
        .map((r) => r[1])
    ),
    faces = []
  for (let i = 1; i < ys.length; i++)
    for (let j = 1; j < xs.length; j++) {
      const top = ys[i - 1],
        bottom = ys[i],
        left = xs[j - 1],
        right = xs[j]
      if (
        classifyTableRuleEdge(s.horizontal, 1, top, left, right) !== 1 ||
        classifyTableRuleEdge(s.horizontal, 1, bottom, left, right) !== 1 ||
        classifyTableRuleEdge(s.vertical, 0, left, top, bottom) !== 1 ||
        classifyTableRuleEdge(s.vertical, 0, right, top, bottom) !== 1
      )
        continue
      const native = [...s.native.values()].filter(
          (f) =>
            f &&
            f.text.trim() &&
            f.rect[0] >= left &&
            f.rect[2] <= right &&
            f.baseline > top &&
            f.baseline < bottom
        ),
        owners = s.owned.filter((p) => p.fonts.every((f) => native.includes(f)))
      if (
        !native.length ||
        native.some(
          (f) =>
            !f.nativeLabelRect ||
            f.nativeLabelRect[1] <= top ||
            f.nativeLabelRect[3] >= bottom ||
            !owners.some((p) => p.fonts.includes(f))
        ) ||
        !nativeExclusiveOwnerBand(s, native, [left, top, right, bottom])
      )
        continue
      faces.push({
        left,
        right,
        top,
        bottom,
        owners,
        rows: [...new Set(owners.map((p) => p.cell.row))].sort((a, b) => a - b),
        fonts: native
      })
    }
  return faces
    .filter(
      (f) =>
        f.rows.length === 2 &&
        f.owners.every((p) => p.cell.colSpan === 1 && p.cell.rowSpan === 1) &&
        faces.some(
          (p) =>
            p !== f &&
            p.left === f.left &&
            p.right === f.right &&
            p.rows.length === 1 &&
            p.top < f.top &&
            Math.abs(p.bottom - p.top - (f.bottom - f.top)) < 0.01 &&
            new Set(p.fonts.map((f) => f.baseline.toFixed(2))).size >= 2
        )
    )
    .map((f) => ({
      rect: [f.left, f.top, f.right, f.bottom],
      rows: f.rows,
      sourceOrder: f.fonts.map((g) => g.sourceItem.index)
    }))
}
function closedHeaderEmptyLane(s) {
  const out = [],
    empty = (c) => c && !c.text.trim() && !c.sourceItems?.length && !c.sourceSegments?.length
  for (const p of s.owned.filter(
    (p) =>
      p.cell.row > 1 &&
      p.cell.column > 0 &&
      p.cell.colSpan === 1 &&
      p.cell.rowSpan === 1 &&
      p.fonts.length === 1
  )) {
    const f = p.fonts[0],
      h = f.height,
      col = p.cell.column,
      blank = s.table.cells.find(
        (c) => c.row === p.cell.row && c.column === col - 1 && c.rowSpan === 1 && c.colSpan === 1
      )
    if (!empty(blank) || !/^\d[\d,]*(?:\s+)\p{L}/u.test(f.text)) continue
    const head = s.owned.find((q) => q.cell.row === 1 && q.cell.column === col),
      left = s.owned.find((q) => q.cell.row === 1 && q.cell.column === col - 1)
    if (
      !head ||
      !left ||
      head.cell.colSpan !== 1 ||
      left.cell.colSpan !== 1 ||
      left.box[2] >= head.box[0]
    )
      continue
    const peers = s.owned
      .filter(
        (q) =>
          q.cell.row > 1 &&
          q.cell.row !== p.cell.row &&
          q.cell.column === col &&
          q.cell.rowSpan === 1 &&
          q.cell.colSpan === 1 &&
          q.fonts.length === 1 &&
          nativeSingleOwnerLine(q)
      )
      .flatMap((q) => {
        const a = s.owned.find(
          (a) =>
            a.cell.row === q.cell.row &&
            a.cell.column === col - 1 &&
            a.cell.rowSpan === 1 &&
            a.cell.colSpan === 1 &&
            a.fonts.length === 1 &&
            nativeSingleOwnerLine(a)
        )
        return a &&
          /^[\d,]+$/u.test(a.cell.text) &&
          Math.abs(a.fonts[0].baseline - q.fonts[0].baseline) < h * 0.1 &&
          a.box[2] < q.box[0]
          ? [{ a, b: q }]
          : []
      })
    if (
      peers.length < 3 ||
      peers.some(
        ({ a, b }) =>
          Math.abs(a.box[0] - peers[0].a.box[0]) > h * 0.5 ||
          Math.abs(b.box[0] - peers[0].b.box[0]) > h * 0.5
      ) ||
      Math.abs(f.rect[0] - peers[0].a.box[0]) > h * 0.5 ||
      f.rect[2] < Math.min(...peers.map(({ b }) => b.box[2]))
    )
      continue
    const all = [
        ...head.fonts,
        ...left.fonts,
        f,
        ...peers.flatMap(({ a, b }) => [...a.fonts, ...b.fonts])
      ],
      b = nativeOwnerLabelBounds(all)
    if (
      !s.horizontal.some(
        (r) =>
          r[0] <= b[0] &&
          r[2] >= b[2] &&
          r[1] > Math.max(head.box[3], left.box[3]) &&
          r[1] < f.nativeLabelRect[1]
      ) ||
      !s.horizontal.some((r) => r[0] <= b[0] && r[2] >= b[2] && r[1] > b[3])
    )
      continue
    if (!nativeExclusiveOwnerBand(s, all, b)) continue
    out.push({
      row: p.cell.row,
      emptyColumn: col - 1,
      wholeSourceOwnerColumn: col,
      source: f.sourceItem,
      independentPeerRows: peers.map(({ a }) => a.cell.row)
    })
  }
  return out
}
function centeredSourceTail(s) {
  const out = [],
    leaf = s.owned.filter((p) => p.cell.row > 0 && p.cell.rowSpan === 1 && p.cell.colSpan === 1),
    near = (a, b, h) => Math.abs(a - b) < h * 0.1
  const anchors = (row) => {
    const fields = leaf.filter(
      (p) =>
        p.cell.row === row && p.cell.column >= 0 && p.cell.column < 3 && nativeSingleOwnerLine(p)
    )
    return fields.length === 3 && new Set(fields.map((p) => p.cell.column)).size === 3 ? fields : []
  }
  const consecutive = (a, b) =>
    a.sourceItem.pageNumber === b.sourceItem.pageNumber &&
    a.sourceItem.index < b.sourceItem.index &&
    ![...s.native.values()].some(
      (f) =>
        f &&
        f.text.trim() &&
        f.sourceItem.index > a.sourceItem.index &&
        f.sourceItem.index < b.sourceItem.index
    )
  const calibrations = leaf.flatMap((p) => {
    const aa = anchors(p.cell.row)
    if (
      aa.length < 3 ||
      aa.some((a) => !near(a.fonts[0].baseline, aa[0].fonts[0].baseline, aa[0].fonts[0].height))
    )
      return []
    const ys = [...new Set(p.fonts.map((f) => f.baseline))].sort((a, b) => a - b),
      h = aa[0].fonts[0].height
    if (
      ys.length !== 2 ||
      ys[1] - ys[0] <= h ||
      !near((ys[0] + ys[1]) / 2, aa[0].fonts[0].baseline, h)
    )
      return []
    return [{ p, step: ys[1] - ys[0], h }]
  })
  for (const p of leaf) {
    const aa = anchors(p.cell.row),
      before = leaf.find((q) => q.cell.row === p.cell.row - 1 && q.cell.column === p.cell.column),
      bb = anchors(p.cell.row - 1)
    if (!before || aa.length < 3 || bb.length < 3) continue
    const anchor = aa.find((p) => p.cell.column === 0)?.fonts[0],
      oldAnchor = bb.find((p) => p.cell.column === 0)?.fonts[0]
    if (!anchor || !oldAnchor) continue
    const h = anchor.height,
      own = p.fonts.filter((f) => near(f.baseline, anchor.baseline, h)),
      tail = p.fonts.filter((f) => f.baseline < anchor.baseline - h)
    if (
      !own.length ||
      tail.length !== 1 ||
      aa.some((q) => q.fonts.some((f) => !near(f.baseline, anchor.baseline, h))) ||
      bb.some((q) => q.fonts.some((f) => !near(f.baseline, oldAnchor.baseline, h)))
    )
      continue
    const f = tail[0],
      last = [...before.fonts].sort((a, b) => a.sourceItem.index - b.sourceItem.index).at(-1),
      top = Math.min(...before.fonts.map((f) => f.baseline)),
      b = nativeOwnerLabelBounds(before.fonts)
    if (
      !last ||
      !consecutive(last, f) ||
      !consecutive(f, anchor) ||
      !near((top + f.baseline) / 2, oldAnchor.baseline, h) ||
      !near((b[0] + b[2]) / 2, (f.rect[0] + f.rect[2]) / 2, h) ||
      before.fonts.some((g) => !near(g.height, h, h)) ||
      !near(f.height, h, h) ||
      own.some((g) => g.sourceItem.index <= anchor.sourceItem.index)
    )
      continue
    const witnesses = calibrations.filter(
      (c) => c.p !== p && c.p !== before && near(c.step, f.baseline - top, h) && near(c.h, h, h)
    )
    if (
      witnesses.length < 2 ||
      !nativeExclusiveOwnerBand(
        s,
        [...before.fonts, ...p.fonts],
        nativeOwnerLabelBounds([...before.fonts, ...p.fonts])
      )
    )
      continue
    out.push({
      row: p.cell.row,
      column: p.cell.column,
      tail: f.sourceItem,
      previousRow: p.cell.row - 1,
      previousSource: last.sourceItem,
      nextRecordSource: anchor.sourceItem,
      calibrationCells: witnesses.map((w) => [w.p.cell.row, w.p.cell.column])
    })
  }
  return out
}

// Reuse complete native owners for two narrow contradictions. Neither proof
// changes the proposed grid, mapped source claims, text, or image bounds.
const closeNativeAttachment = (a, b, h) => Math.abs(a - b) < h * 0.05
function nativeClosedScalarOrScriptConflicts(
  table,
  bandOwners,
  native,
  inventory,
  rules,
  measuredRuns,
  counts
) {
  const band = bandOwners
    .filter((p) =>
      p.fonts.every(
        (f) =>
          native.get(key(f.sourceItem)) === f &&
          f.sourceItem.pageNumber === table.page &&
          f.rect[2] > f.rect[0] &&
          f.rect[3] > f.rect[1] &&
          verifiedNativeLabelRect(f) &&
          Number.isFinite(f.fontDescent)
      )
    )
    .map((p) => ({ ...p, box: nativeOwnerLabelBounds(p.fonts) }))
  const s = {
    table,
    band,
    measuredRuns,
    counts,
    owned: band.filter(
      (p) => compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join(''))
    ),
    native,
    inventory,
    horizontal: rules.filter((r) => rect(r) && r[1] === r[3])
  }
  return [
    [nativeHeadedFractionCount, 'native-headed-fraction-count-lanes'],
    [nativeAttachedLowerOrder, 'native-attached-subscript-order-conflict'],
    [nativeMeasuredHeadingLeafCollapse, 'native-measured-heading-leaf-collapse']
  ].flatMap(([prove, tag]) => (prove(s).length ? [tag] : []))
}
function nativeHeadedFractionCount(s) {
  const column = s.table.grid[0].length - 1,
    heads = s.band.filter(
      (p) =>
        p.cell.row === 0 && p.cell.column === column && p.cell.rowSpan === 1 && p.cell.colSpan === 1
    ),
    result = []
  for (const head of heads) {
    const ff = [...head.fonts].sort((a, b) => a.sourceItem.index - b.sourceItem.index),
      top = Math.min(...ff.map((f) => f.baseline)),
      bottom = Math.max(...ff.map((f) => f.baseline)),
      h = Math.max(...ff.map((f) => f.height))
    if (
      !(bottom - top >= h && bottom - top < h * 1.5) ||
      ff.some((f) => !closeNativeAttachment(f.height, h, h))
    )
      continue
    const labels = ff
      .filter(
        (f) => closeNativeAttachment(f.baseline, top, h) && /^[\p{L}.]{2,32}$/u.test(f.text.trim())
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (labels.length !== 2) continue
    const groups = labels.map((label, i) =>
      ff.filter((f) => (i === 0 ? f.rect[2] <= labels[1].rect[0] : f.rect[0] >= labels[1].rect[0]))
    )
    if (
      groups.flat().length !== ff.length ||
      groups.some(
        (g) =>
          !g.some((f) => closeNativeAttachment(f.baseline, bottom, h) && /^[↑↓]$/u.test(f.text))
      ) ||
      groups[1].length !== 2 ||
      groups[0].length < 2
    )
      continue
    const frames = groups.map(nativeOwnerLabelBounds)
    if (frames[0][2] >= frames[1][0]) continue
    const lane = s.owned.filter(
        (p) =>
          p.cell.row > 0 && p.cell.column === column && p.cell.rowSpan === 1 && p.cell.colSpan === 1
      ),
      pairs = lane.flatMap((p) => {
        const f = [...p.fonts].sort((a, b) => a.rect[0] - b.rect[0])
        return f.length === 2 &&
          /^\d+\/\d+$/u.test(f[0].text) &&
          /^\d+$/u.test(f[1].text) &&
          closeNativeAttachment(f[0].baseline, f[1].baseline, h) &&
          f.every((v) => closeNativeAttachment(v.height, h, h)) &&
          closeNativeAttachment(f[0].rect[2], frames[0][2], h) &&
          closeNativeAttachment(f[1].rect[2], frames[1][2], h) &&
          s.owned.filter(
            (q) =>
              q.cell.row === p.cell.row &&
              q.cell.column < column &&
              q.cell.column > 0 &&
              q.cell.rowSpan === 1 &&
              q.cell.colSpan === 1 &&
              q.fonts.length === 1 &&
              /^\d+(?:\/\d+)?$/u.test(q.cell.text) &&
              closeNativeAttachment(q.fonts[0].baseline, f[0].baseline, h)
          ).length >= 2
          ? [{ p, fonts: f }]
          : []
      })
    if (
      pairs.length < 3 ||
      pairs.length !== lane.length ||
      new Set(pairs.map((p) => p.p.cell.row)).size !== pairs.length
    )
      continue
    const all = [...ff, ...pairs.flatMap((p) => p.fonts)],
      b = nativeOwnerLabelBounds(all),
      gap = [
        Math.max(frames[0][2], ...pairs.map((p) => p.fonts[0].rect[2])),
        Math.min(frames[1][0], ...pairs.map((p) => p.fonts[1].rect[0]))
      ]
    if (
      gap[0] >= gap[1] ||
      !s.horizontal.some(
        (r) =>
          r[0] <= b[0] &&
          r[2] >= b[2] &&
          r[1] > head.box[3] &&
          r[1] < Math.min(...pairs.map((p) => nativeOwnerLabelBounds(p.fonts)[1]))
      ) ||
      !s.horizontal.some((r) => r[0] <= b[0] && r[2] >= b[2] && r[1] < head.box[1]) ||
      !s.horizontal.some((r) => r[0] <= b[0] && r[2] >= b[2] && r[1] > b[3]) ||
      !nativeExclusiveOwnerBand(s, all, [gap[0], b[1], gap[1], b[3]])
    )
      continue
    result.push({
      column,
      headSources: ff.map((f) => f.sourceItem.index),
      rowSources: pairs.map((p) => p.fonts.map((f) => f.sourceItem.index)),
      gap,
      bounds: b
    })
  }
  return result
}
function nativeAttachedLowerOrder(s) {
  const out = []
  for (const p of s.band) {
    if (
      !p.cell.textRuns?.length ||
      compact(p.cell.textRuns.map((r) => r.text).join('')) !== compact(p.cell.text)
    )
      continue
    const ff = p.fonts,
      all = compact(p.cell.text)
    for (const base of ff)
      for (const sub of ff) {
        const h = base.height
        if (
          !/^\p{L}$/u.test(base.text) ||
          !/^\d$/u.test(sub.text) ||
          sub.sourceItem.index !== base.sourceItem.index + 1 ||
          sub.sourceItem.pageNumber !== base.sourceItem.pageNumber ||
          sub.fontAscent !== base.fontAscent ||
          sub.fontDescent !== base.fontDescent ||
          !(sub.height > h * 0.55 && sub.height < h * 0.85) ||
          !(sub.baseline - base.baseline > h * 0.05 && sub.baseline - base.baseline < h * 0.2) ||
          Math.abs(sub.rect[0] - base.rect[2]) > h * 0.01
        )
          continue
        const next = [...s.native.values()]
          .filter(
            (f) =>
              f &&
              f.sourceItem.pageNumber === base.sourceItem.pageNumber &&
              f.sourceItem.index > sub.sourceItem.index
          )
          .sort((a, b) => a.sourceItem.index - b.sourceItem.index)[0]
        if (
          !next ||
          !ff.includes(next) ||
          !closeNativeAttachment(next.height, h, h) ||
          !closeNativeAttachment(next.baseline, base.baseline, h) ||
          !/^\(/u.test(next.text) ||
          next.rect[0] <= sub.rect[2] ||
          !p.cell.textRuns.some(
            (r) => r.position === 'normal' && compact(r.text).includes(sub.text)
          )
        )
          continue
        const b = all.indexOf(base.text),
          z = all.indexOf(sub.text),
          n = all.indexOf(compact(next.text))
        if (
          b < 0 ||
          z < 0 ||
          n < 0 ||
          all.indexOf(base.text, b + 1) >= 0 ||
          all.indexOf(sub.text, z + 1) >= 0 ||
          all.indexOf(compact(next.text), n + 1) >= 0 ||
          !(b < n && n < z) ||
          !nativeExclusiveOwnerBand(s, ff, nativeOwnerLabelBounds([base, sub, next]))
        )
          continue
        const suffix = ff
          .filter((f) => f.sourceItem.index >= next.sourceItem.index)
          .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
          .map((f) => f.text)
          .join('')
        let depth = 0,
          closed = false,
          bad = false
        for (const c of suffix) {
          if (c === '(') depth++
          if (c === ')') {
            if (--depth < 0) bad = true
            if (depth === 0) closed = true
          }
        }
        if (depth || bad || !closed) continue
        out.push({
          cell: [p.cell.row, p.cell.column],
          sources: [base.sourceItem.index, sub.sourceItem.index, next.sourceItem.index],
          nativeOrder: ff.map((f) => f.text).join(''),
          mapped: p.cell.text
        })
      }
  }
  return out
}

// Native glyph advances only certify a contradiction; no split becomes a cell or source range.
function nativeMeasuredLiteralParts(f, runs) {
  const rr = runs.filter(
    (r) =>
      r.text === f.text &&
      same(r.rect, f.rect) &&
      r.baseline === f.baseline &&
      r.height === f.height
  )
  if (rr.length !== 1) return
  const r = rr[0],
    gg = r.literalGlyphs
  if (
    !Array.isArray(gg) ||
    !gg.length ||
    gg.some((g) => typeof g !== 'string' || [...g].length !== 1 || /\s/u.test(g)) ||
    gg.join('') !== compact(f.text) ||
    !Array.isArray(r.glyphRuns) ||
    r.glyphRuns.length !== gg.length ||
    r.glyphRuns.some((i) => !Number.isSafeInteger(i) || i < 0) ||
    !Array.isArray(r.gaps)
  )
    return
  const words = f.text.trim().split(/\s+/u)
  if (words.length !== r.gaps.length + 1) return
  let offset = 0,
    left = f.rect[0]
  const out = []
  for (let i = 0; i <= r.gaps.length; i++) {
    const gap = r.gaps[i],
      end = gap?.index ?? gg.length,
      right = gap?.left ?? f.rect[2],
      text = gg.slice(offset, end).join('')
    if (
      !Number.isSafeInteger(end) ||
      end <= offset ||
      end > gg.length ||
      text !== words[i] ||
      !Number.isFinite(right) ||
      right <= left ||
      (gap && (!Number.isFinite(gap.right) || gap.right <= right || gap.right >= f.rect[2]))
    )
      return
    out.push({
      text,
      rect: [left, f.nativeLabelRect[1], right, f.nativeLabelRect[3]],
      font: f,
      source: [offset, end]
    })
    left = gap?.right
    offset = end
  }
  return out
}
const nativeMeasuredLabel = (f, table) =>
  canonicalNativeFont(f) &&
  f.sourceItem.pageNumber === table.page &&
  f.rect[2] > f.rect[0] &&
  f.rect[3] > f.rect[1] &&
  verifiedNativeLabelRect(f) &&
  Number.isFinite(f.fontDescent)
function nativeMeasuredHeadingLeafCollapse(s) {
  const runs = s.measuredRuns
  if (!Array.isArray(runs) || !runs.length) return []
  const table = s.table,
    owners = s.owned,
    out = []
  for (const f of s.native.values()) {
    if (!nativeMeasuredLabel(f, table)) continue
    const hh = nativeMeasuredLiteralParts(f, runs)
    if (!hh || hh.length !== 4 || hh.some((p) => !/^\p{Lu}{2,12}$/u.test(p.text))) continue
    const headerOwners = s.band.filter((p) => p.fonts.includes(f)),
      inside =
        headerOwners.length === 1 &&
        headerOwners[0].fonts.length === 1 &&
        headerOwners[0].cell.rowSpan === 1 &&
        headerOwners[0].cell.colSpan === 3,
      outside =
        !s.counts.has(f.sourceItem.pageNumber + ':' + f.sourceItem.index) &&
        f.nativeLabelRect[3] < table.cropRect[1]
    if (!inside && !outside) continue
    const h = f.height,
      head = nativeOwnerLabelBounds([f]),
      bars = s.horizontal.filter((r) => r[0] <= head[0] && r[2] >= head[2]),
      above = bars.filter((r) => r[1] < head[1]).sort((a, b) => b[1] - a[1])[0],
      below = bars.filter((r) => r[1] > head[3]).sort((a, b) => a[1] - b[1])[0]
    if (
      !above ||
      !below ||
      below[1] - head[3] >= h ||
      (outside && Math.abs(below[1] - table.cropRect[1]) > 1e-6) ||
      !nativeExclusiveOwnerBand(s, [f], head)
    )
      continue
    const matches = []
    for (const row of new Set(owners.map((p) => p.cell.row))) {
      const pp = owners.filter(
        (p) =>
          p.cell.row === row &&
          p.cell.rowSpan === 1 &&
          p.cell.colSpan === 1 &&
          p.fonts.every(
            (t) =>
              nativeMeasuredLabel(t, table) &&
              closeNativeAttachment(t.height, h, h) &&
              t.sourceItem.index > f.sourceItem.index &&
              t.nativeLabelRect[1] > below[1]
          )
      )
      for (let j = 0; j < pp.length; j++) {
        const cells = pp.slice(j, j + 3).sort((a, b) => a.cell.column - b.cell.column)
        if (
          cells.length !== 3 ||
          cells.some((p, n) => n && p.cell.column !== cells[n - 1].cell.column + 1) ||
          (inside && cells[0].cell.column !== headerOwners[0].cell.column)
        )
          continue
        const ff = cells.flatMap((p) => p.fonts),
          parts = ff
            .flatMap((t) => nativeMeasuredLiteralParts(t, runs) ?? [])
            .sort((a, b) => a.rect[0] - b.rect[0])
        if (
          parts.length !== 4 ||
          ff.some((t) => !nativeMeasuredLiteralParts(t, runs)) ||
          parts.some(
            (p, n) =>
              !/^[+−-]?\d+(?:\.\d+)?$/u.test(p.text) ||
              !closeNativeAttachment(p.rect[2], hh[n].rect[2], h)
          ) ||
          ff.some((t) => !closeNativeAttachment(t.baseline, ff[0].baseline, h)) ||
          !bars.some((r) => r[1] > Math.max(...ff.map((t) => t.nativeLabelRect[3]))) ||
          !nativeExclusiveOwnerBand(s, ff, nativeOwnerLabelBounds(ff))
        )
          continue
        const gutters = []
        for (let n = 1; n < hh.length; n++) {
          const left = Math.max(hh[n - 1].rect[2], parts[n - 1].rect[2]),
            right = Math.min(hh[n].rect[0], parts[n].rect[0])
          if (!(right > left)) {
            gutters.length = 0
            break
          }
          gutters.push([left, right])
        }
        if (gutters.length !== 3) continue
        matches.push({
          row,
          cells: cells.map((p) => [p.cell.row, p.cell.column]),
          parts: parts.map((p) => ({
            text: p.text,
            rect: p.rect,
            source: p.font.sourceItem.index,
            range: p.source
          })),
          fonts: ff,
          gutters
        })
      }
    }
    if (matches.length >= 3 && new Set(matches.map((p) => p.row)).size === matches.length)
      out.push({
        header: {
          source: f.sourceItem.index,
          text: f.text,
          parts: hh.map((p) => ({ text: p.text, rect: p.rect, range: p.source }))
        },
        mode: inside
          ? 'complete-owned-heading-span'
          : 'unowned-heading-in-independent-native-frame',
        rows: matches.map((m) => ({
          row: m.row,
          cells: m.cells,
          parts: m.parts,
          gutters: m.gutters
        }))
      })
  }
  return out
}

// A whole native header may not be published both in its spanning parent and
// again in a lower leaf beside an independent source. This is an ownership
// contradiction only; it does not infer header spans or assert paint visibility.
function nativeDuplicatedParentSource(table, inventory, font, fontEnvelope) {
  const grid = table.grid,
    validRect = (r) => rect(r) && r[0] < r[2] && r[1] < r[3]
  if (
    !Number.isSafeInteger(table.page) ||
    table.page < 1 ||
    !Array.isArray(grid) ||
    grid.length < 2 ||
    !Array.isArray(grid[0]) ||
    grid[0].length < 2 ||
    grid.some((row) => !Array.isArray(row) || row.length !== grid[0].length)
  )
    return false
  const tuple = (c) =>
    c &&
    Number.isSafeInteger(c.row) &&
    c.row >= 0 &&
    Number.isSafeInteger(c.column) &&
    c.column >= 0 &&
    Number.isSafeInteger(c.rowSpan) &&
    c.rowSpan > 0 &&
    Number.isSafeInteger(c.colSpan) &&
    c.colSpan > 0 &&
    c.row + c.rowSpan <= grid.length &&
    c.column + c.colSpan <= grid[0].length
  const native = new Map(),
    claims = new Map()
  for (const f of inventory) {
    if (!f?.sourceItem) continue
    const k = key(f.sourceItem)
    native.set(k, native.has(k) ? undefined : f)
  }
  for (const c of table.cells)
    for (const o of c.sourceItems ?? []) {
      const k = key(o)
      if (!claims.has(k)) claims.set(k, [])
      claims.get(k).push(c)
    }
  const whole = (c) => {
    if (
      'sourceSegments' in c ||
      !c.sourceItems?.length ||
      c.sourceRects?.length !== c.sourceItems.length ||
      typeof c.text !== 'string' ||
      new Set(c.sourceItems.map(key)).size !== c.sourceItems.length
    )
      return
    const ff = c.sourceItems.map((o) => native.get(key(o)))
    if (
      ff.some(
        (f, i) =>
          !f ||
          !f.horizontal ||
          !validRect(f.rect) ||
          !Number.isFinite(f.height) ||
          !(f.height > 0) ||
          !Number.isFinite(f.baseline) ||
          f.sourceItem.pageNumber !== table.page ||
          !Number.isSafeInteger(f.sourceItem.index) ||
          f.sourceItem.index < 0 ||
          f.text !== c.sourceItems[i].text ||
          f.sourceItem.text !== f.text ||
          !same(f.rect, c.sourceRects[i]) ||
          !font(f)
      ) ||
      compact(ff.map((f) => f.text).join('')) !== compact(c.text)
    )
      return
    return ff
  }
  for (const [k, owners] of claims) {
    if (owners.length !== 2 || owners[0] === owners[1]) continue
    const parent = owners.find((c) => c.colSpan >= 2 && c.rowSpan === 1),
      child = owners.find((c) => c.colSpan === 1 && c.rowSpan === 1)
    if (
      !tuple(parent) ||
      !tuple(child) ||
      child.row !== parent.row + 1 ||
      child.column < parent.column ||
      child.column >= parent.column + parent.colSpan
    )
      continue
    const f = native.get(k),
      a = whole(parent),
      b = whole(child)
    if (
      !f ||
      !a ||
      !b ||
      a.filter((g) => g === f).length !== 1 ||
      b.filter((g) => g === f).length !== 1 ||
      b.length < 2
    )
      continue
    const peers = b.filter((g) => g !== f),
      h = f.height,
      y = f.baseline,
      lower = peers[0].baseline
    if (
      a.some((g) => Math.abs(g.baseline - y) > h * 0.02 || Math.abs(g.height - h) > h * 0.02) ||
      peers.some(
        (g) => Math.abs(g.baseline - lower) > h * 0.02 || Math.abs(g.height - h) > h * 0.02
      ) ||
      lower - y <= h * 0.8 ||
      lower - y >= h * 1.6
    )
      continue
    const upperBox = bounds(a.map((g) => ({ rect: fontEnvelope(g) }))),
      lowerBox = bounds(peers.map((g) => ({ rect: fontEnvelope(g) })))
    if (upperBox[3] < lowerBox[1]) return true
  }
  return false
}

// A printed partial rule separates the native group from an independent upper
// heading. Repeated scalar lanes below that boundary can contradict a single
// modeled column, but never supply replacement column cuts.
const ruledOwnerRect = (r) => rect(r) && r[0] < r[2] && r[1] < r[3]
const ruledOwnerHit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const ruledOwnerBox = (rr) => bounds(rr.map((rect) => ({ rect })))
function nativeRuledHeaderLanes(t, inventory, rules, context) {
  if (
    !t?.cells?.length ||
    !Array.isArray(t.grid) ||
    t.grid.length < 4 ||
    !Array.isArray(t.grid[0]) ||
    t.grid[0].length < 3 ||
    t.grid.some((r) => !Array.isArray(r) || r.length !== t.grid[0].length) ||
    !Number.isSafeInteger(t.page) ||
    !ruledOwnerRect(t.cropRect) ||
    !Array.isArray(inventory) ||
    !Array.isArray(rules)
  )
    return []
  if (
    !(context?.rulePaintBounds instanceof Map) ||
    !Array.isArray(context.nativePaintIdentityGraphics)
  )
    return []
  const tf = context?.viewport?.transform,
    content = context?.sourceContent
  if (
    !Array.isArray(tf) ||
    tf.length !== 6 ||
    !tf.every(Number.isFinite) ||
    !(tf[0] > 0) ||
    tf[1] !== 0 ||
    tf[2] !== 0 ||
    tf[3] !== -tf[0] ||
    !content?.items ||
    !content.styles
  )
    return []
  const tuple = (c) =>
    c &&
    Number.isSafeInteger(c.row) &&
    c.row >= 0 &&
    Number.isSafeInteger(c.column) &&
    c.column >= 0 &&
    Number.isSafeInteger(c.rowSpan) &&
    c.rowSpan > 0 &&
    Number.isSafeInteger(c.colSpan) &&
    c.colSpan > 0 &&
    c.row + c.rowSpan <= t.grid.length &&
    c.column + c.colSpan <= t.grid[0].length
  const fonts = new Map(),
    owner = new Map(),
    all = []
  for (const f of inventory) {
    if (!f || typeof f.text !== 'string') return []
    if (!f.text.trim()) continue
    if (!f.sourceItem) return []
    const o = f.sourceItem,
      n = content.items[o.index],
      s = content.styles[n?.fontName]
    if (!f.horizontal) {
      const m = n?.transform,
        v = {
          ...context.viewport,
          convertToViewportPoint: (x, y) => [x * tf[0] + tf[4], y * tf[3] + tf[5]]
        }
      if (
        !n ||
        n.str !== f.text ||
        o.text !== f.text ||
        o.pageNumber !== t.page ||
        !Number.isSafeInteger(o.index) ||
        o.index < 0 ||
        n.dir !== 'ltr' ||
        !Array.isArray(m) ||
        m.length !== 6 ||
        !m.every(Number.isFinite) ||
        !s ||
        s.vertical !== false ||
        !Number.isFinite(s.ascent) ||
        s.ascent <= 0 ||
        !Number.isFinite(s.descent) ||
        s.ascent <= s.descent ||
        !Number.isFinite(n.width) ||
        n.width <= 0 ||
        n.height !== Math.hypot(m[2], m[3]) ||
        Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-10 ||
        !(Math.hypot(m[0], m[1]) > 0) ||
        !same(f.rect, rotatedTextRect(n, v))
      )
        return []
      const dx = (m[0] / Math.hypot(m[0], m[1])) * n.width,
        dy = (m[1] / Math.hypot(m[0], m[1])) * n.width,
        corners = [s.descent, s.ascent]
          .flatMap((z) => [
            [m[4] + m[2] * z, m[5] + m[3] * z],
            [m[4] + m[2] * z + dx, m[5] + m[3] * z + dy]
          ])
          .map(([x, y]) => v.convertToViewportPoint(x, y)),
        envelope = ruledOwnerBox([...corners.map(([x, y]) => [x, y, x, y]), f.rect])
      all.push({ font: f, native: n, style: s, envelope })
      if (fonts.has(key(o))) return []
      fonts.set(key(o), undefined)
      continue
    }
    if (
      fonts.has(key(o)) ||
      o.pageNumber !== t.page ||
      !Number.isSafeInteger(o.index) ||
      o.index < 0 ||
      !f.horizontal ||
      !ruledOwnerRect(f.rect) ||
      !(f.height > 0) ||
      !Number.isFinite(f.baseline) ||
      o.text !== f.text ||
      n?.str !== f.text ||
      n.dir !== 'ltr' ||
      !Array.isArray(n.transform) ||
      n.transform.length !== 6 ||
      !n.transform.every(Number.isFinite) ||
      !(n.transform[0] > 0) ||
      n.transform[1] !== 0 ||
      n.transform[2] !== 0 ||
      n.transform[3] !== n.height ||
      !(n.height > 0) ||
      !(n.width > 0) ||
      !Number.isFinite(n.width) ||
      !s ||
      s.vertical !== false ||
      !Number.isFinite(s.ascent) ||
      !(s.ascent > 0) ||
      !Number.isFinite(s.descent) ||
      s.ascent <= s.descent
    )
      return []
    const x = n.transform[4] * tf[0] + tf[4],
      y = n.transform[5] * tf[3] + tf[5],
      h = n.height * tf[0]
    if (
      !same(f.rect, [x, y - h, x + n.width * tf[0], y]) ||
      Math.abs(f.height - h) > 1e-6 ||
      Math.abs(f.baseline - y) > 1e-6
    )
      return []
    const rec = {
      font: f,
      native: n,
      style: s,
      envelope: [
        x,
        Math.min(y - h, y - s.ascent * h),
        x + n.width * tf[0],
        Math.max(y, y - s.descent * h)
      ]
    }
    fonts.set(key(o), rec)
    all.push(rec)
  }
  const whole = new Map()
  for (const c of t.cells) {
    if (!tuple(c) || typeof c.text !== 'string' || 'sourceSegments' in c) return []
    if (!c.sourceItems?.length) {
      if (c.text.trim()) return []
      continue
    }
    if (
      c.sourceRects?.length !== c.sourceItems.length ||
      new Set(c.sourceItems.map(key)).size !== c.sourceItems.length
    )
      return []
    const ff = c.sourceItems.map((o) => fonts.get(key(o)))
    if (
      ff.some(
        (r, i) =>
          !r ||
          !r.font.horizontal ||
          r.font.sourceItem.pageNumber !== c.sourceItems[i].pageNumber ||
          r.font.sourceItem.index !== c.sourceItems[i].index ||
          r.font.text !== c.sourceItems[i].text ||
          !same(r.font.rect, c.sourceRects[i])
      ) ||
      compact(ff.map((r) => r.font.text).join('')) !== compact(c.text)
    )
      return []
    for (const o of c.sourceItems) {
      if (owner.has(key(o))) return []
      owner.set(key(o), c)
    }
    whole.set(c, ff)
  }
  const results = []
  for (const [parent, pf] of whole) {
    if (parent.row !== 0 || parent.rowSpan !== 1 || parent.colSpan < 2 || pf.length !== 2) continue
    const [left, right] = [...pf].sort((a, b) => a.font.rect[0] - b.font.rect[0]),
      h = left.font.height
    if (
      Math.abs(right.font.height - h) > h * 0.02 ||
      Math.abs(left.font.baseline - right.font.baseline) > h * 0.02 ||
      left.envelope[2] >= right.envelope[0]
    )
      continue
    for (const [leaf, lf] of whole) {
      if (
        leaf.row !== 1 ||
        leaf.rowSpan !== 1 ||
        leaf.colSpan !== 1 ||
        leaf.column < parent.column ||
        leaf.column >= parent.column + parent.colSpan ||
        lf.length !== 1
      )
        continue
      const l = lf[0]
      if (Math.abs(l.font.height - h) > h * 0.02 || l.envelope[2] >= right.envelope[0]) continue
      const separators = rules.filter(
        (r) =>
          Array.isArray(r) &&
          r.length === 4 &&
          r.every(Number.isFinite) &&
          r[1] === r[3] &&
          r[0] < r[2] &&
          r[0] <= left.envelope[0] &&
          r[2] >= left.envelope[2] &&
          r[0] <= l.envelope[0] &&
          r[2] >= l.envelope[2] &&
          r[2] < right.envelope[0] &&
          r[1] > Math.max(left.envelope[3], right.envelope[3]) &&
          r[1] < l.envelope[1] &&
          r[2] - l.envelope[2] < h * 0.2
      )
      if (separators.length !== 1) continue
      const edge = separators[0],
        paint = visibleNativeHeaderRule(edge, context, all)
      if (!paint) continue
      const rows = []
      for (let row = 2; row < t.grid.length; row++) {
        const cc = t.cells.filter(
          (c) => c.row === row && c.column === leaf.column && c.rowSpan === 1 && c.colSpan === 1
        )
        if (cc.length !== 1) break
        const ff = whole.get(cc[0])
        if (!ff || ff.length !== 2) break
        const [a, b] = [...ff].sort((x, y) => x.font.rect[0] - y.font.rect[0])
        if (
          !/^[+−-]?\d+(?:\.\d+)?$/u.test(a.font.text) ||
          !/^[+−-]?\d+(?:\.\d+)?$/u.test(b.font.text) ||
          Math.abs(a.font.baseline - b.font.baseline) > h * 0.02 ||
          Math.abs(a.font.height - h) > h * 0.02 ||
          Math.abs(b.font.height - h) > h * 0.02 ||
          a.envelope[2] > edge[2] ||
          b.envelope[0] <= edge[2] ||
          Math.abs(a.envelope[2] - l.envelope[2]) > h * 0.02 ||
          Math.abs(b.envelope[2] - right.envelope[2]) > h * 0.02 ||
          a.envelope[2] >= b.envelope[0]
        )
          break
        rows.push({ cell: cc[0], left: a, right: b })
      }
      if (rows.length !== t.grid.length - 2 || rows.length < 2) continue
      const role = [left, right, l, ...rows.flatMap((r) => [r.left, r.right])],
        domain = ruledOwnerBox(role.map((r) => r.envelope)),
        lo = Math.min(...role.map((r) => r.font.sourceItem.index)),
        hi = Math.max(...role.map((r) => r.font.sourceItem.index))
      if (
        all.some(
          (r) =>
            !owner.has(key(r.font.sourceItem)) &&
            (ruledOwnerHit(r.envelope, domain) ||
              (r.font.sourceItem.index >= lo && r.font.sourceItem.index <= hi))
        )
      )
        continue
      results.push(true)
    }
  }
  return results
}

export function visibleNativeHeaderRule(rule, context, fonts) {
  const o = context.operators,
    v = context.viewport,
    g = context.nativePaintIdentityGraphics,
    paint = context.rulePaintBounds?.get(rule.join(','))
  if (
    !o ||
    !Array.isArray(o.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    !Array.isArray(g) ||
    !ruledOwnerRect(paint)
  )
    return
  // The existing geometry observer does not interpret transfer functions,
  // transparency groups or non-default soft masks. Such state cannot certify
  // a visible group boundary, even if its geometric stroke and CA are known.
  const allowed = new Set([
    OPS.dependency,
    OPS.beginText,
    OPS.endText,
    OPS.setFont,
    OPS.moveText,
    OPS.setTextMatrix,
    OPS.showText,
    OPS.save,
    OPS.restore,
    OPS.transform,
    OPS.paintFormXObjectBegin,
    OPS.paintFormXObjectEnd,
    OPS.setFillRGBColor,
    OPS.setStrokeRGBColor,
    OPS.setLineWidth,
    OPS.setLineCap,
    OPS.setLineJoin,
    OPS.setMiterLimit,
    OPS.setDash,
    OPS.setGState,
    OPS.clip,
    OPS.eoClip,
    OPS.constructPath,
    OPS.paintImageXObject
  ])
  for (const [i, op] of o.fnArray.entries()) {
    if (!allowed.has(op)) return
    if (op !== OPS.setGState) continue
    const entries = o.argsArray[i]?.[0]
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          !(
            (['CA', 'ca'].includes(entry[0]) &&
              Number.isFinite(entry[1]) &&
              entry[1] >= 0 &&
              entry[1] <= 1) ||
            (entry[0] === 'SMask' && entry[1] === false) ||
            (entry[0] === 'BM' && ['Normal', 'source-over'].includes(entry[1]))
          )
      )
    )
      return
  }
  const e = { paths: new Map(), texts: new Map(), frames: new Map(), images: [] }
  collectClosedFigureFrames(o, v, e)
  const painted = [...e.paths].filter(
      ([i]) => ![OPS.endPath, OPS.clip, OPS.eoClip].includes(o.argsArray[i]?.[0])
    ),
    ids = new Map()
  for (const x of g) {
    if (
      !x ||
      !Number.isSafeInteger(x.operationIndex) ||
      x.operationIndex < 0 ||
      !['path', 'image'].includes(x.kind) ||
      !ruledOwnerRect(x.rect) ||
      ids.has(x.operationIndex)
    )
      return
    ids.set(x.operationIndex, x.kind)
  }
  if (
    e.images.length !== g.filter((x) => x.kind === 'image').length ||
    painted.length !== g.filter((x) => x.kind === 'path').length ||
    painted.some(([i]) => ids.get(i) !== 'path') ||
    e.images.some((im) => ids.get(im.operationIndex) !== 'image')
  )
    return
  const matches = []
  for (const [i, state] of painted) {
    const a = o.argsArray[i],
      p = a?.[1]?.[0]
    if (
      a?.[0] !== OPS.stroke ||
      !Array.isArray(a[1]) ||
      a[1].length !== 1 ||
      p?.length !== 6 ||
      !Array.from(p).every(Number.isFinite) ||
      p[0] !== 0 ||
      p[3] !== 1 ||
      p[2] !== p[5] ||
      p[1] === p[4] ||
      !Array.isArray(state.transform) ||
      !state.transform.every(Number.isFinite) ||
      state.transform[0] <= 0 ||
      state.transform[1] !== 0 ||
      state.transform[2] !== 0 ||
      state.transform[3] <= 0 ||
      state.strokeAlpha !== 1 ||
      state.solidStroke !== true ||
      state.lineCap !== 0 ||
      !(state.lineWidth > 0) ||
      !Number.isFinite(state.lineWidth) ||
      !ruledOwnerRect(state.clip)
    )
      continue
    const m = Util.transform(v.transform, state.transform),
      q = [
        [p[1], p[2]],
        [p[4], p[5]]
      ].map((z) => {
        Util.applyTransform(z, m)
        return z
      }),
      r = [Math.min(q[0][0], q[1][0]), q[0][1], Math.max(q[0][0], q[1][0]), q[1][1]]
    if (r.some((n, k) => Math.abs(n - rule[k]) > 1e-6)) continue
    const expected = [
      r[0],
      r[1] - (state.lineWidth * Math.abs(m[3])) / 2,
      r[2],
      r[3] + (state.lineWidth * Math.abs(m[3])) / 2
    ]
    if (
      !same(expected, paint) ||
      paint.some((n, k) => (k < 2 ? n < state.clip[k] : n > state.clip[k])) ||
      g.some((x) => x.operationIndex !== i && ruledOwnerHit(x.rect, paint)) ||
      fonts.some((x) => ruledOwnerHit(x.envelope, paint))
    )
      continue
    let color = '#000000',
      stack = [],
      validColor = true
    for (let n = 0; n < i; n++) {
      const op = o.fnArray[n],
        a = o.argsArray[n]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ op, color })
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        const saved = stack.pop()
        if (!saved || saved.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) {
          validColor = false
          break
        }
        color = saved.color
      } else if (op === OPS.setStrokeRGBColor) color = a?.[0]
      else if (
        [
          OPS.setStrokeGray,
          OPS.setStrokeCMYKColor,
          OPS.setStrokeColor,
          OPS.setStrokeColorN
        ].includes(op)
      ) {
        validColor = false
        break
      }
    }
    if (
      !validColor ||
      typeof color !== 'string' ||
      !/^#[a-f0-9]{6}$/iu.test(color) ||
      color.toLowerCase() === '#ffffff'
    )
      continue
    matches.push(true)
  }
  return matches.length === 1 ? matches[0] : undefined
}

// These two source contradictions add no cells and claim no extra text. A
// complete native packet either proves a split attachment, or supplies two
// independently headed and populated lanes consumed by one measured source.
function nativePacketLeafRoles(s) {
  return (
    s.heads.length === s.count &&
    new Set(s.heads.map((p) => p.cell.column)).size === s.count &&
    s.table.cells.every(
      (c) =>
        c.sourceSegments === undefined &&
        Number.isSafeInteger(c.row) &&
        c.row >= 0 &&
        c.row < s.table.grid.length &&
        Number.isSafeInteger(c.column) &&
        c.column >= 0 &&
        Number.isSafeInteger(c.rowSpan) &&
        c.rowSpan > 0 &&
        c.row + c.rowSpan <= s.table.grid.length &&
        Number.isSafeInteger(c.colSpan) &&
        c.colSpan > 0 &&
        c.column + c.colSpan <= s.count
    )
  )
}
function nativeAttachedSuffixAcrossCell(s) {
  if (!nativePacketLeafRoles(s) || !s.foreignFree(s.leaves.flatMap((p) => p.fonts))) return false
  const owners = new Map()
  for (const p of s.owned)
    for (const f of p.fonts) {
      if (owners.has(f.sourceItem.index)) return false
      owners.set(f.sourceItem.index, p)
    }
  const all = [...s.inventory].sort((a, b) => a.sourceItem.index - b.sourceItem.index),
    next = (f) => all.find((q) => q.text.trim() && q.sourceItem.index > f.sourceItem.index),
    valid = (f) => !!f && !!s.font(f)
  const pair = (base, sub) => {
    if (!valid(base) || !valid(sub)) return false
    const h = base.height,
      dx = sub.rect[0] - base.rect[2],
      dy = sub.baseline - base.baseline
    return (
      /^\p{L}$/u.test(base.text) &&
      /^\p{L}{1,24}$/u.test(sub.text) &&
      sub.sourceItem.index === base.sourceItem.index + 1 &&
      sub.height > h * 0.55 &&
      sub.height < h * 0.85 &&
      dy > 0 &&
      dy < h * 0.5 &&
      dx >= 0 &&
      dx < h * 0.03
    )
  }
  for (const p of s.owned.filter(
    (p) =>
      p.cell.row > 0 &&
      p.cell.rowSpan === 1 &&
      p.cell.colSpan === 1 &&
      Array.isArray(p.cell.textRuns)
  ))
    for (const a of p.fonts) {
      const sub = next(a)
      if (
        !pair(a, sub) ||
        !p.fonts.includes(sub) ||
        !p.cell.textRuns.some(
          (r) => r.position === 'subscript' && compact(r.text) === compact(sub.text)
        )
      )
        continue
      const arrow = next(sub),
        base = arrow && next(arrow),
        suffix = base && next(base)
      if (
        !valid(arrow) ||
        arrow.text !== '→' ||
        !valid(base) ||
        !pair(base, suffix) ||
        !p.fonts.includes(arrow) ||
        !p.fonts.includes(base) ||
        a.text !== base.text ||
        a.height !== base.height ||
        s.font(a).fontName !== s.font(base).fontName ||
        sub.height !== suffix.height ||
        s.font(sub).fontName !== s.font(suffix).fontName
      )
        continue
      const q = owners.get(suffix.sourceItem.index)
      if (
        q &&
        q !== p &&
        q.cell.row === p.cell.row &&
        q.cell.column === p.cell.column + 1 &&
        q.cell.rowSpan === 1 &&
        q.cell.colSpan === 1 &&
        s.foreignFree([base, suffix])
      )
        return true
    }
  return false
}
function nativeMeasuredTailAcrossLanes(s, runs) {
  if (!nativePacketLeafRoles(s) || !Array.isArray(runs)) return false
  const parts = (f) => nativeMeasuredLiteralParts(f, runs),
    leaf = (row, column) => s.leaves.filter((p) => p.cell.row === row && p.cell.column === column),
    valid = (f) => !!s.font(f),
    unit = (p) => {
      const words = p?.flatMap((f) => parts(f) ?? [])
      return words?.length === 2 && /^\d+$/u.test(words[0].text) && /^\p{L}+$/u.test(words[1].text)
        ? words
        : undefined
    }
  for (const p of s.body.filter((p) => p.fonts.length === 1)) {
    const f = p.fonts[0],
      ff = parts(f),
      col = p.cell.column
    if (
      !ff ||
      ff.length !== 3 ||
      !valid(f) ||
      !/^\d+(?:\.\d+)?$/u.test(ff[0].text) ||
      !/^\d+$/u.test(ff[1].text) ||
      !/^\p{L}+$/u.test(ff[2].text)
    )
      continue
    const empty = s.table.cells.filter(
        (c) =>
          c.row === p.cell.row &&
          c.column === col + 1 &&
          c.rowSpan === 1 &&
          c.colSpan === 1 &&
          c.text === '' &&
          !c.sourceItems?.length &&
          !c.sourceRects?.length
      ),
      h = s.heads.filter((q) => q.cell.column === col || q.cell.column === col + 1)
    if (
      empty.length !== 1 ||
      h.length !== 2 ||
      h.some((q) => !q.fonts.length || q.fonts.some((f) => !valid(f)))
    )
      continue
    h.sort((a, b) => a.cell.column - b.cell.column)
    for (const a of s.body.filter(
      (q) => q.cell.row !== p.cell.row && q.cell.column === col && q.fonts.length === 1
    )) {
      const pp = parts(a.fonts[0]),
        q = leaf(a.cell.row, col + 1)
      if (
        !pp ||
        pp.length !== 1 ||
        !/^\d+(?:\.\d+)?$/u.test(pp[0].text) ||
        q.length !== 1 ||
        !unit(q[0].fonts) ||
        a.fonts[0].height !== f.height ||
        q[0].fonts.some((g) => g.height !== f.height || !valid(g)) ||
        s.font(a.fonts[0]).fontName !== s.font(f).fontName ||
        q[0].fonts.some((g) => s.font(g).fontName !== s.font(f).fontName) ||
        Math.abs(a.fonts[0].baseline - q[0].fonts[0].baseline) > 1e-6
      )
        continue
      const right = unit(q[0].fonts),
        leftMax = Math.max(ff[0].rect[2], pp[0].rect[2], ...h[0].fonts.map((f) => f.rect[2])),
        rightMin = Math.min(ff[1].rect[0], right[0].rect[0], ...h[1].fonts.map((f) => f.rect[0])),
        peers = s.body.filter(
          (p) =>
            [col, col + 1].includes(p.cell.column) &&
            p.fonts.length === 1 &&
            p.fonts.every(
              (g) => valid(g) && g.height === f.height && s.font(g).fontName === s.font(f).fontName
            )
        ),
        roles = [...new Set([...h.flatMap((p) => p.fonts), f, ...peers.flatMap((p) => p.fonts)])]
      if (
        leftMax < rightMin &&
        ff[0].rect[0] <= Math.min(...h[0].fonts.map((f) => f.rect[0])) &&
        ff[2].rect[2] >= Math.max(...h[1].fonts.map((f) => f.rect[2])) &&
        nativeClosedRolePacket(s, roles)
      )
        return true
    }
  }
  return false
}
function nativeClosedRolePacket(s, roles) {
  const ids = new Set(),
    nativeIds = new Set()
  for (const f of s.inventory) {
    if (!canonicalNativeFont(f) || !s.font(f) || nativeIds.has(f.sourceItem.index)) return false
    nativeIds.add(f.sourceItem.index)
  }
  const owned = s.leaves.flatMap((p) => p.fonts)
  for (const f of owned) {
    if (ids.has(f.sourceItem.index)) return false
    ids.add(f.sourceItem.index)
  }
  if (!ids.size) return false
  const lo = Math.min(...ids),
    hi = Math.max(...ids)
  if (
    s.inventory.some(
      (f) => f.sourceItem.index >= lo && f.sourceItem.index <= hi && !ids.has(f.sourceItem.index)
    )
  )
    return false
  const own = new Set(roles)
  if (roles.some((f) => !ids.has(f.sourceItem.index))) return false
  const rr = roles.map(s.fontEnvelope)
  if (rr.some((r) => !r)) return false
  const box = [
    Math.min(...rr.map((r) => r[0])),
    Math.min(...rr.map((r) => r[1])),
    Math.max(...rr.map((r) => r[2])),
    Math.max(...rr.map((r) => r[3]))
  ]
  return s.inventory.every((f) => {
    if (own.has(f)) return true
    const r = s.fontEnvelope(f)
    return r && (r[0] >= box[2] || r[2] <= box[0] || r[1] >= box[3] || r[3] <= box[1])
  })
}

// A native list record has an independent first-line anchor. Three complete
// successor records and an omitted predecessor must close the same source
// packet before its tail can disprove the proposed next grid row. This does
// not classify prose from its words or infer replacement rows.
function nativeOrdinalRecordTail(table, leaves, inventory, rules, font, content) {
  if (
    table.caption ||
    rules.length ||
    table.grid.length < 4 ||
    table.grid.some((row) => row.length !== 2) ||
    table.cells.length !== table.grid.length * 2 ||
    table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1 || c.sourceSegments?.length)
  )
    return false
  const empty = table.cells.filter((c) => c.row === 0 && c.column === 0)
  if (empty.length !== 1 || empty[0].text?.trim() || empty[0].sourceItems?.length) return false
  const roman = (text) => {
      const values = [
        'i',
        'ii',
        'iii',
        'iv',
        'v',
        'vi',
        'vii',
        'viii',
        'ix',
        'x',
        'xi',
        'xii',
        'xiii',
        'xiv',
        'xv',
        'xvi',
        'xvii',
        'xviii',
        'xix',
        'xx'
      ]
      return values.indexOf(text.trim().replace(/\.$/u, '')) + 1
    },
    byCell = new Map(leaves.map((p) => [p.cell.row + ':' + p.cell.column, p])),
    stubs = [],
    bodies = []
  for (let row = 1; row < table.grid.length; row++) {
    const a = byCell.get(row + ':0'),
      b = byCell.get(row + ':1')
    if (
      !a ||
      a.fonts.length !== 1 ||
      !/^[ivx]+\.$/u.test(a.fonts[0].text) ||
      !roman(a.fonts[0].text) ||
      !b
    )
      return false
    stubs.push(a.fonts[0])
    bodies.push(b)
  }
  const firstBody = byCell.get('0:1'),
    first = stubs[0],
    h = first.height
  if (
    !firstBody ||
    stubs.length < 3 ||
    stubs.some(
      (f, i) =>
        (i && roman(f.text) !== roman(stubs[i - 1].text) + 1) ||
        Math.abs(f.rect[2] - first.rect[2]) > h * 0.05
    )
  )
    return false
  const predecessor = inventory.filter(
    (f) =>
      canonicalNativeFont(f) &&
      /^[ivx]+\.$/u.test(f.text) &&
      roman(f.text) === roman(first.text) - 1 &&
      f.sourceItem.index < first.sourceItem.index &&
      Math.abs(f.rect[2] - first.rect[2]) < h * 0.05
  )
  if (predecessor.length !== 1) return false
  const prior = predecessor[0],
    allOwned = leaves.flatMap((p) => p.fonts),
    end = Math.max(...allOwned.map((f) => f.sourceItem.index)),
    packet = inventory.filter(
      (f) => f.sourceItem.index >= prior.sourceItem.index && f.sourceItem.index <= end
    ),
    ids = new Set(packet.map((f) => f.sourceItem.index)),
    owner = new Map(leaves.flatMap((p) => p.fonts.map((f) => [f, p.cell.row]))),
    box = bounds(packet),
    lastBaseline = Math.max(...packet.map((f) => f.baseline))
  if (
    ids.size !== packet.length ||
    !content?.items ||
    content.items.some(
      (item, index) =>
        index >= prior.sourceItem.index && index <= end && item.str?.trim() && !ids.has(index)
    ) ||
    owner.has(prior) ||
    !table.unassigned?.includes(prior.text) ||
    inventory.some(
      (f) =>
        !canonicalNativeFont(f) ||
        !font(f) ||
        (!packet.includes(f) &&
          f.baseline >= prior.baseline - h * 0.05 &&
          f.baseline <= lastBaseline + h * 0.05 &&
          f.rect[0] < box[2] &&
          f.rect[2] > box[0])
    ) ||
    allOwned.some((f) => !packet.includes(f)) ||
    packet.some(
      (f) =>
        !canonicalNativeFont(f) ||
        !font(f) ||
        font(f).fontName !== font(first).fontName ||
        Math.abs(f.height - h) > h * 0.01 ||
        (!owner.has(f) && !table.unassigned.includes(f.text))
    )
  )
    return false
  const markers = [prior, ...stubs],
    records = []
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i],
      next = markers[i + 1],
      ff = packet.filter(
        (f) =>
          f.sourceItem.index > marker.sourceItem.index &&
          (!next || f.sourceItem.index < next.sourceItem.index)
      ),
      lines = []
    for (const f of ff.sort((a, b) => a.sourceItem.index - b.sourceItem.index)) {
      const last = lines.at(-1)
      if (last && Math.abs(last[0].baseline - f.baseline) < h * 0.05) {
        if (f.rect[0] < last.at(-1).rect[2] - h * 0.05) return false
        last.push(f)
      } else lines.push([f])
    }
    if (
      lines.length < 3 ||
      !/[.!?]$/u.test(lines.at(-1).at(-1).text.trim()) ||
      Math.abs(lines[0][0].baseline - marker.baseline) > h * 0.05 ||
      lines.some(
        (line, j) =>
          Math.abs(line[0].rect[0] - firstBody.box[0]) > h * 0.05 ||
          line.some((f) => f.rect[0] <= marker.rect[2] + h) ||
          (j &&
            (line[0].baseline - lines[j - 1][0].baseline < h ||
              line[0].baseline - lines[j - 1][0].baseline > h * 1.3))
      ) ||
      (next &&
        (next.baseline - lines.at(-1)[0].baseline < h ||
          next.baseline - lines.at(-1)[0].baseline > h * 1.3))
    )
      return false
    records.push(ff)
  }
  // Every independent successor starts at its marker and is otherwise owned
  // by that grid row. Only the predecessor tail may cross into the next row.
  if (records.slice(1).some((ff, i) => ff.some((f) => owner.get(f) !== i + 1))) return false
  const previous = records[0],
    tail = previous.filter((f) => owner.get(f) === 1),
    retained = previous.filter((f) => owner.get(f) === 0)
  return (
    tail.length > 0 &&
    retained.length > 0 &&
    previous.every((f) => !owner.has(f) || owner.get(f) === 0 || owner.get(f) === 1) &&
    Math.max(...retained.map((f) => f.sourceItem.index)) <
      Math.min(...tail.map((f) => f.sourceItem.index)) &&
    previous
      .filter((f) => !owner.has(f))
      .every((f) => f.sourceItem.index < Math.min(...retained.map((f) => f.sourceItem.index))) &&
    bodies[0].fonts.every((f) => records[1].includes(f) || tail.includes(f))
  )
}

// Native source contradictions only; no replacement grid or synthesized owner.
function nativeMathematicalMarkEvidence(owned, inventory, rules, context) {
  const result = new Set(),
    affected = new Set(),
    mathOwned = owned.filter(
      (p) =>
        [...compact(p.cell.text)].sort().join('') ===
        [...compact(p.fonts.map((f) => f.text).join(''))].sort().join('')
    )
  const horizontal = rules.filter((r) => rect(r) && Math.abs(r[1] - r[3]) < 1e-6 && r[2] > r[0]),
    envelope = inventory.map((f) => ({ envelope: f.nativeLabelRect ?? f.rect })),
    visible = new Map(),
    printed = (r) => {
      if (!(context?.rulePaintBounds instanceof Map) || envelope.some((f) => !rect(f.envelope)))
        return false
      if (!visible.has(r)) visible.set(r, !!visibleNativeHeaderRule(r, context, envelope))
      return visible.get(r)
    }
  // Equal-size, raised native glyphs over a Greek operand are two-dimensional
  // source, even when the embedded encoding calls the accent an ordinary letter.
  for (const p of mathOwned)
    for (const base of p.fonts.filter((f) => /^[\p{Script=Greek}∆]$/u.test(f.text.trim())))
      for (const mark of p.fonts.filter((f) => /^[\p{L}ˆ¯˜ˉ]$/u.test(f.text.trim()))) {
        const h = base.height
        if (
          mark === base ||
          !/^[\p{Script=Greek}∆]$/u.test(base.text.trim()) ||
          !/^[\p{L}ˆ¯˜ˉ]$/u.test(mark.text.trim()) ||
          Math.abs(mark.height - h) > h * 0.02 ||
          !Number.isFinite(mark.fontAscent) ||
          !Number.isFinite(mark.fontDescent) ||
          base.baseline - mark.baseline < h * 0.15 ||
          base.baseline - mark.baseline > h * 0.4 ||
          Math.min(mark.rect[2], base.rect[2]) - Math.max(mark.rect[0], base.rect[0]) <
            Math.min(mark.rect[2] - mark.rect[0], base.rect[2] - base.rect[0]) * 0.7
        )
          continue
        result.add('native-overlapping-mathematical-mark')
        affected.add(mark)
        affected.add(base)
      }
  // A short, independently visible rule the width of a Greek operand cannot
  // disappear when its complete native cell is flattened to ordinary text.
  for (const p of mathOwned)
    for (const f of p.fonts.filter((f) => /^[\p{Script=Greek}∆]$/u.test(f.text.trim()))) {
      const h = f.height
      for (const r of horizontal)
        if (
          Math.abs(r[0] - f.rect[0]) < h * 0.02 &&
          Math.abs(r[2] - f.rect[2]) < h * 0.02 &&
          r[1] >= f.rect[1] &&
          r[1] < f.rect[1] + h * 0.2 &&
          !p.fonts.some(
            (g) =>
              g !== f &&
              g.rect[0] < r[2] &&
              g.rect[2] > r[0] &&
              g.baseline < f.baseline - h * 0.1 &&
              g.baseline > f.rect[1]
          ) &&
          printed(r)
        ) {
          result.add('native-vector-mathematical-mark-omitted')
          affected.add(f)
        }
    }
  return {
    conflicts: [...result],
    sources: [...affected].map((f) => f.sourceItem)
  }
}

function nativeIndependentRecordConflicts(owned) {
  const result = new Set(),
    plain = (p) => p.cell.colSpan === 1 && p.cell.rowSpan === 1,
    literal = (ff) =>
      compact(
        [...ff]
          .sort((a, b) => a.rect[0] - b.rect[0])
          .map((f) => f.text)
          .join('')
      ),
    scalar = (s) =>
      /^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/\d+|\([+−-]?(?:\d+(?:\.\d+)?|\.\d+)\)|±(?:\d+(?:\.\d+)?|\.\d+))?$/u.test(
        s
      ),
    oneLine = (ff) =>
      ff.every(
        (f) => Math.abs(f.baseline - ff[0].baseline) < Math.max(...ff.map((f) => f.height)) * 0.05
      )
  // Repeated means and same-baseline uncertainty suffixes are separate native
  // records. A smaller uncertainty font is neither an exponent nor a new line.
  const stacked = []
  for (const p of owned.filter((p) => plain(p) && p.cell.row > 0)) {
    const h = Math.max(...p.fonts.map((f) => f.height)),
      lines = []
    for (const f of [...p.fonts].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const last = lines.at(-1)
      if (last && Math.abs(last.baseline - f.baseline) < h * 0.05) last.fonts.push(f)
      else lines.push({ baseline: f.baseline, fonts: [f] })
    }
    if (
      lines.length < 2 ||
      !lines.some((l) => literal(l.fonts).includes('±')) ||
      lines.some(
        (l, i) =>
          !scalar(literal(l.fonts)) ||
          l.fonts.some((f) => f.height < h * 0.6 || f.height > h * 1.02) ||
          (i && l.baseline - lines[i - 1].baseline < h * 0.9)
      ) ||
      !owned.some(
        (q) =>
          q.cell.column === p.cell.column && q.cell.row < p.cell.row && /\p{L}/u.test(q.cell.text)
      )
    )
      continue
    stacked.push({ p, h, lines })
  }
  for (const a of stacked)
    if (
      new Set(
        stacked
          .filter(
            (b) =>
              b.p.cell.row === a.p.cell.row &&
              b.lines.length === a.lines.length &&
              b.lines.every(
                (l, i) => Math.abs(l.baseline - a.lines[i].baseline) < Math.min(a.h, b.h) * 0.05
              )
          )
          .map((b) => b.p.cell.column)
      ).size >= 3
    )
      result.add('native-uncertainty-records-collapsed')
  // Two independent printed headings and three aligned numeric pairs establish
  // two value lanes even when a scalar or uncertainty was split into many runs.
  for (const head of owned.filter(
    (p) => plain(p) && p.cell.row === 0 && p.fonts.length === 2 && oneLine(p.fonts)
  )) {
    const hh = [...head.fonts].sort((a, b) => a.rect[0] - b.rect[0]),
      h = Math.max(...hh.map((f) => f.height))
    if (hh.some((f) => !/\p{L}/u.test(f.text)) || hh[1].rect[0] - hh[0].rect[2] < h * 1.25) continue
    let count = 0
    for (const p of owned.filter(
      (p) =>
        plain(p) &&
        p.cell.row > head.cell.row &&
        p.cell.column === head.cell.column &&
        oneLine(p.fonts)
    )) {
      const ff = [...p.fonts].sort((a, b) => a.rect[0] - b.rect[0]),
        gaps = ff.flatMap((f, i) => (i && f.rect[0] - ff[i - 1].rect[2] > h * 0.7 ? [i] : []))
      if (gaps.length !== 1) continue
      const parts = [ff.slice(0, gaps[0]), ff.slice(gaps[0])]
      if (
        parts.some(
          (part, i) =>
            !scalar(literal(part)) ||
            Math.abs((bounds(part)[0] + bounds(part)[2] - hh[i].rect[0] - hh[i].rect[2]) / 2) >
              h * 0.3
        )
      )
        continue
      count++
    }
    if (count >= 3) result.add('native-independent-numeric-header-lanes-collapsed')
  }
  // Repeated numeric cycles independently anchor top-aligned section labels.
  // A model span that starts in the previous cycle contradicts those anchors.
  const stubs = owned.filter(
      (p) =>
        p.cell.row > 0 &&
        p.cell.column === 0 &&
        p.cell.colSpan === 1 &&
        p.fonts.length === 1 &&
        /\p{L}{2}/u.test(p.cell.text)
    ),
    lane = owned
      .filter(
        (p) =>
          plain(p) &&
          p.cell.column === 1 &&
          p.cell.row > 0 &&
          p.fonts.length === 1 &&
          /^\d+$/u.test(compact(p.cell.text))
      )
      .sort((a, b) => a.cell.row - b.cell.row)
  for (let period = 2; period <= 8; period++) {
    if (
      stubs.length < 3 ||
      lane.length !== stubs.length * period ||
      new Set(lane.slice(0, period).map((p) => compact(p.cell.text))).size !== period ||
      lane.some((p, i) => compact(p.cell.text) !== compact(lane[i % period].cell.text))
    )
      continue
    const anchors = stubs.map((stub) => {
      const f = stub.fonts[0],
        matches = lane.filter(
          (p, i) => i % period === 0 && Math.abs(p.fonts[0].baseline - f.baseline) < f.height * 0.05
        )
      return matches.length === 1 ? { stub, first: matches[0] } : undefined
    })
    if (anchors.some((a) => !a) || new Set(anchors.map((a) => a.first)).size !== stubs.length)
      continue
    if (anchors.filter((a) => a.stub.cell.row === a.first.cell.row).length < 2) continue
    if (anchors.some((a) => a.stub.cell.row !== a.first.cell.row || a.stub.cell.rowSpan > period))
      result.add('native-section-label-crosses-repeated-cycle')
  }
  return [...result]
}

function nativePrintedGroupConflicts(owned, inventory, rules, context) {
  const result = new Set(),
    plain = (p) => p.cell.colSpan === 1 && p.cell.rowSpan === 1
  const horizontal = rules.filter((r) => rect(r) && Math.abs(r[1] - r[3]) < 1e-6 && r[2] > r[0]),
    envelope = inventory.map((f) => ({ envelope: f.nativeLabelRect ?? f.rect })),
    visible = new Map(),
    printed = (r) => {
      if (!(context?.rulePaintBounds instanceof Map) || envelope.some((f) => !rect(f.envelope)))
        return false
      if (!visible.has(r)) visible.set(r, !!visibleNativeHeaderRule(r, context, envelope))
      return visible.get(r)
    }
  // A bounded group underline and its complete printed leaf headings constrain
  // every column of the upper heading; centred text alone cannot narrow a span.
  for (const r of horizontal) {
    const upper = owned.filter(
      (p) =>
        p.cell.row < 2 &&
        p.box[3] < r[1] &&
        r[1] - p.box[3] < Math.max(...p.fonts.map((f) => f.height)) * 1.1 &&
        p.box[0] >= r[0] - Math.max(...p.fonts.map((f) => f.height)) * 0.3 &&
        p.box[2] <= r[2] + 1e-6
    )
    if (!upper.length) continue
    const row = upper[0].cell.row,
      h = Math.max(...upper.flatMap((p) => p.fonts.map((f) => f.height)))
    if (
      upper.some((p) => p.cell.row !== row) ||
      !(
        upper.flatMap((p) => p.fonts).length === 1 ||
        (upper.flatMap((p) => p.fonts).every((f) => compact(f.text).length === 1) &&
          /[+/(=]/u.test(upper.map((p) => p.cell.text).join('')))
      )
    )
      continue
    const leaves = owned.filter(
      (p) =>
        plain(p) &&
        p.cell.row === row + 1 &&
        p.box[1] > r[1] &&
        p.box[1] - r[1] < h * 1.2 &&
        (p.box[0] + p.box[2]) / 2 > r[0] &&
        (p.box[0] + p.box[2]) / 2 < r[2] + 1e-6
    )
    if (
      leaves.length < 2 ||
      new Set(leaves.map((p) => p.cell.column)).size !== leaves.length ||
      leaves.some((p) => Math.abs(p.fonts[0].baseline - leaves[0].fonts[0].baseline) > h * 0.05)
    )
      continue
    const columns = leaves.map((p) => p.cell.column).sort((a, b) => a - b)
    if (columns.some((c, i) => i && c !== columns[i - 1] + 1) || !printed(r)) continue
    if (
      upper.length !== 1 ||
      upper[0].cell.column !== columns[0] ||
      upper[0].cell.colSpan !== columns.length
    )
      result.add('native-printed-group-span-contradiction')
  }
  // A complete repeated child-heading pair cannot split a single mathematical
  // parent packet at an unmatched delimiter across two ordinary leaf cells.
  for (const a of owned.filter(
    (p) => plain(p) && p.cell.row === 0 && /\($/u.test(compact(p.cell.text))
  )) {
    const b = owned.find(
        (p) => plain(p) && p.cell.row === 0 && p.cell.column === a.cell.column + 1
      ),
      h = a.fonts[0].height
    if (
      !b ||
      !/\)$/u.test(compact(b.cell.text)) ||
      !a.cell.text.includes('/') ||
      Math.abs(a.box[3] - b.box[3]) > h * 0.6 ||
      b.box[0] - a.box[2] > h * 0.3
    )
      continue
    const children = [a.cell.column, b.cell.column].map((c) =>
      owned.find((p) => plain(p) && p.cell.row === 1 && p.cell.column === c)
    )
    if (children.some((p) => !p)) continue
    const formula = compact(a.cell.text + b.cell.text)
    let depth = 0,
      closed = true
    for (const c of formula) {
      if (c === '(') depth++
      if (c === ')' && --depth < 0) closed = false
    }
    if (!closed || depth) continue
    const witness = owned.some(
      (p) =>
        p.cell.row === 0 &&
        p.cell.colSpan === 2 &&
        p.cell.rowSpan === 1 &&
        p.cell.column + 2 <= a.cell.column &&
        [0, 1].every((i) =>
          owned.some(
            (q) =>
              plain(q) &&
              q.cell.row === 1 &&
              q.cell.column === p.cell.column + i &&
              compact(q.cell.text) === compact(children[i].cell.text) &&
              Math.abs(q.fonts[0].baseline - children[i].fonts[0].baseline) < h * 0.05
          )
        )
    )
    if (witness) result.add('native-mathematical-group-split-between-leaves')
  }
  return [...result]
}

// A fully bound terminal native packet continues one numbered record.
function nativeTerminalNumberedRecordTail(table, owned, inventory, rules, font, content, context) {
  if (!content?.items || !content.styles || !Number.isSafeInteger(table.page)) return false
  const leaves = owned.filter(
    (p) =>
      p.cell.rowSpan === 1 &&
      p.cell.colSpan === 1 &&
      compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join('')) &&
      p.fonts.every(canonicalNativeFont)
  )
  const numbered = leaves
    .filter((p) => p.cell.column === 0 && p.cell.row > 0)
    .flatMap((p) => {
      const labels = p.fonts.filter((f) => /^[A-Za-z]\d+$/u.test(f.text.trim()))
      return labels.length === 1 &&
        labels[0].sourceItem.index === Math.min(...p.fonts.map((f) => f.sourceItem.index))
        ? [
            {
              p,
              label: labels[0],
              number: Number(labels[0].text.trim().slice(1)),
              prefix: labels[0].text.trim()[0]
            }
          ]
        : []
    })
    .sort((a, b) => a.p.cell.row - b.p.cell.row)
  if (
    numbered.length >= 4 &&
    numbered.every(
      (p, i) =>
        !i ||
        (p.number === numbered[i - 1].number + 1 &&
          p.prefix === numbered[0].prefix &&
          p.p.cell.row === numbered[i - 1].p.cell.row + 1)
    )
  ) {
    const last = numbered.at(-1),
      h = last.label.height,
      tail = leaves.find((p) => p.cell.column === 0 && p.cell.row === last.p.cell.row + 1),
      body = last.p.fonts
        .filter((f) => f !== last.label)
        .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
      first = body[0],
      end = body.at(-1),
      foreign = (lo, hi) => content.items.some((i, n) => n > lo && n < hi && i.str?.trim())
    if (!tail || tail.cell.row !== table.grid.length - 1) return false
    const packet = [...numbered.flatMap((n) => n.p.fonts), ...tail.fonts],
      ids = new Set(packet.map(fontKey)),
      box = bounds(packet)
    let glyphFonts
    const provedFont = (f) =>
      font(f) ||
      (glyphFonts ??= nativeNumberedRecordGlyphFonts(table, context)).some(
        (r) =>
          r.index === f.sourceItem.index &&
          r.r.str === f.text &&
          same(
            r.rect.map((n) => n * context.viewport.scale),
            f.rect
          ) &&
          Math.abs(f.height - r.r.height * context.viewport.scale) < 1e-6 &&
          Math.abs(f.baseline - f.rect[3]) < 1e-6
      )
    if (
      ids.size !== packet.length ||
      packet.some((f) => !canonicalNativeFont(f) || !provedFont(f)) ||
      inventory.some(
        (f) =>
          !ids.has(fontKey(f)) &&
          f.text?.trim() &&
          (!rect(f.rect) ||
            (f.rect[0] < box[2] && f.rect[2] > box[0] && f.rect[1] < box[3] && f.rect[3] > box[1]))
      ) ||
      rules.some(
        (r) =>
          rect(r) &&
          r[1] === r[3] &&
          r[1] > end?.baseline &&
          r[1] < tail.fonts[0]?.rect[1] &&
          r[0] <= box[0] &&
          r[2] >= box[2]
      )
    )
      return false
    const witnesses = numbered.slice(0, -1).flatMap(({ p, label }) => {
        const ff = p.fonts
          .filter((f) => f !== label)
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
        if (
          ff.length < 2 ||
          ff.some((f) => Math.abs(f.height - h) > h * 0.02) ||
          Math.abs(ff[0].rect[0] - first?.rect[0]) > h * 0.05
        )
          return []
        const next = ff.find(
          (f) => f.baseline - ff[0].baseline > h * 0.9 && f.baseline - ff[0].baseline < h * 1.6
        )
        return next ? [next.baseline - ff[0].baseline] : []
      }),
      step = witnesses[0]
    if (
      tail &&
      first &&
      end &&
      /-$/u.test(last.p.cell.text.trim()) &&
      tail.fonts.length === 1 &&
      /^[\p{L}]/u.test(tail.cell.text.trim()) &&
      witnesses.length >= 3 &&
      witnesses.every((s) => Math.abs(s - step) < h * 0.05) &&
      Math.abs(tail.fonts[0].rect[0] - first.rect[0]) < h * 0.05 &&
      Math.abs(tail.fonts[0].height - h) < h * 0.02 &&
      Math.abs(tail.fonts[0].baseline - end.baseline - step) < h * 0.05 &&
      tail.fonts[0].sourceItem.index > end.sourceItem.index &&
      content.items &&
      !foreign(end.sourceItem.index, tail.fonts[0].sourceItem.index) &&
      numbered.every(({ label }) => Math.abs(label.rect[0] - last.label.rect[0]) < h * 0.05)
    )
      return true
  }

  return false
}

// Zero font-wide ascent is not a font proof. Only the existing exact renderer
// packet may bind such a source; incomplete outlines, advances or clips abstain.
function nativeNumberedRecordGlyphFonts(table, context) {
  try {
    const p = context?.nativeGlyphContext,
      v = context?.viewport,
      source = context?.sourceContent
    if (
      !p ||
      !source ||
      context.content !== source ||
      p.sourceSha256 !== context.sourceSha256 ||
      !/^[a-f0-9]{64}$/u.test(p.sourceSha256) ||
      p.viewport?.scale !== 1 ||
      p.viewport.rotation !== 0 ||
      v?.rotation !== 0 ||
      !(v.scale > 0) ||
      !Array.isArray(v.transform) ||
      v.transform.length !== 6 ||
      !v.transform.every(Number.isFinite) ||
      !same(v.transform.slice(0, 4), [v.scale, 0, 0, -v.scale]) ||
      v.transform[4] !== 0 ||
      v.transform[5] !== v.height ||
      v.width !== p.viewport.width * v.scale ||
      v.height !== p.viewport.height * v.scale ||
      !Array.isArray(p.viewport.transform) ||
      !isDeepStrictEqual(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height])
    )
      return []
    const bound = matchNativeFigureRenderContext(
      p,
      table.page,
      source,
      p.viewport,
      context.sourcePage?.graphicsBounds,
      context.sourceSha256
    )
    if (
      !bound ||
      source.items.some(
        (r, i) => !isDeepStrictEqual(r.sourceItem, bound.content.items[i].sourceItem)
      )
    )
      return []
    const aliases = new Map(
        bound.content.items.map((r, i) => [r.fontName, source.items[i].fontName])
      ),
      mapped = (a) =>
        Array.isArray(a) ? a.map(mapped) : typeof a === 'string' ? (aliases.get(a) ?? a) : a
    if (
      !isDeepStrictEqual(bound.operators.fnArray, context.operators?.fnArray) ||
      !isDeepStrictEqual(mapped(bound.operators.argsArray), context.operators?.argsArray)
    )
      return []
    const tokens = bound.content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, bound.viewport, 0)),
      packet = nativePageTextPacketInventory(context.sourcePage, tokens, bound)
    if (!packet) return []
    return packet.records.filter(
      (r) =>
        r.r.dir === 'ltr' &&
        r.r.transform[1] === 0 &&
        r.r.transform[2] === 0 &&
        r.r.transform[0] > 0 &&
        r.r.transform[3] > 0 &&
        r.r.height === r.r.transform[3]
    )
  } catch {
    return []
  }
}

// A complete native word may wrap inside its own column. Its prefix cannot be
// claimed by the next column when the native stream and calibrated lanes agree.
function nativeWrappedWordPrefixConflicts(owned, inventory, font) {
  const complete = owned.filter(
      (p) =>
        p.cell.rowSpan === 1 &&
        p.cell.colSpan === 1 &&
        compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join('')) &&
        p.fonts.every((f) => canonicalNativeFont(f) && font(f))
    ),
    conflicts = new Set(),
    lane = (column, excluded, h) => {
      const peers = complete.filter(
        (p) =>
          p.cell.row > 0 &&
          p.cell.row !== excluded &&
          p.cell.column === column &&
          p.fonts.every((f) => Math.abs(f.height - h) < h * 0.02)
      )
      if (!peers.some((p) => p.cell.row < excluded) || !peers.some((p) => p.cell.row > excluded))
        return
      const starts = peers.map((p) => p.box[0])
      if (Math.max(...starts) - Math.min(...starts) > h * 0.1) return
      return [Math.min(...starts), Math.max(...peers.map((p) => p.box[2]))]
    },
    claimed = new Map()
  for (const p of owned)
    for (const f of p.fonts) {
      const k = key(f.sourceItem)
      claimed.set(k, claimed.has(k) ? undefined : p)
    }
  for (const wrong of complete.filter((p) => p.cell.row > 0))
    for (const prefix of wrong.fonts.filter((f) => /^\p{L}{2,}-$/u.test(f.text))) {
      const next = inventory.filter((f) => f.sourceItem?.index === prefix.sourceItem.index + 1)
      if (next.length !== 1) continue
      const tail = next[0],
        home = claimed.get(key(tail.sourceItem)),
        h = prefix.height
      if (
        !home ||
        home === wrong ||
        !complete.includes(home) ||
        home.cell.row !== wrong.cell.row ||
        home.cell.column + 1 !== wrong.cell.column ||
        !/^\p{Ll}/u.test(tail.text) ||
        !font(tail) ||
        font(tail).fontName !== font(prefix).fontName ||
        Math.abs(tail.height - h) > h * 0.02 ||
        tail.baseline - prefix.baseline < h ||
        tail.baseline - prefix.baseline > h * 1.4
      )
        continue
      const preceding = inventory
        .filter((f) => f.sourceItem?.index < prefix.sourceItem.index && f.text?.trim())
        .sort((a, b) => b.sourceItem.index - a.sourceItem.index)[0]
      if (
        !preceding ||
        !home.fonts.includes(preceding) ||
        !font(preceding) ||
        font(preceding).fontName !== font(prefix).fontName ||
        Math.abs(preceding.height - h) > h * 0.02 ||
        Math.abs(preceding.baseline - prefix.baseline) > h * 0.05 ||
        prefix.rect[0] - preceding.rect[2] < 0 ||
        prefix.rect[0] - preceding.rect[2] > h * 2
      )
        continue
      const ownLane = lane(home.cell.column, home.cell.row, h),
        foreignLane = lane(wrong.cell.column, wrong.cell.row, h)
      if (
        !ownLane ||
        !foreignLane ||
        foreignLane[0] - ownLane[1] < h * 0.5 ||
        Math.abs(home.box[0] - ownLane[0]) > h * 0.1 ||
        Math.abs(tail.rect[0] - ownLane[0]) > h * 0.1 ||
        prefix.rect[0] < ownLane[0] ||
        prefix.rect[2] > foreignLane[0] - h * 0.5 ||
        home.fonts.some(
          (f) => f.rect[0] < ownLane[0] - h * 0.1 || f.rect[2] > ownLane[1] + h * 0.1
        ) ||
        !wrong.fonts.some((f) => f !== prefix) ||
        wrong.fonts.some(
          (f) =>
            f !== prefix &&
            (f.rect[0] < foreignLane[0] - h * 0.1 || f.rect[2] > foreignLane[1] + h * 0.1)
        )
      )
        continue
      conflicts.add('native-wrapped-word-prefix-assigned-to-adjacent-column')
    }
  return [...conflicts]
}

function nativeCalibratedRecordPackets(table, inventory, font, rules, context) {
  const byOrigin = new Map(),
    claims = new Map(),
    complete = [],
    tags = new Set()
  for (const f of inventory) {
    if (!f.sourceItem) continue
    const k = key(f.sourceItem)
    byOrigin.set(k, byOrigin.has(k) || !canonicalNativeFont(f) || !font(f) ? undefined : f)
  }
  for (const c of table.cells)
    for (const o of c.sourceItems ?? []) claims.set(key(o), (claims.get(key(o)) ?? 0) + 1)
  for (const cell of table.cells) {
    if (
      cell.sourceSegments?.length ||
      !cell.sourceItems?.length ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1
    )
      continue
    const ff = cell.sourceItems.map((o) => byOrigin.get(key(o)))
    if (
      cell.sourceRects?.length !== ff.length ||
      ff.some(
        (f, i) =>
          !f ||
          f.text !== cell.sourceItems[i].text ||
          claims.get(key(f.sourceItem)) !== 1 ||
          cell.sourceRects.filter((r) => same(r, f.rect)).length !== 1
      ) ||
      compact(cell.text) !== compact(ff.map((f) => f.text).join(''))
    )
      continue
    complete.push({ cell, fonts: ff })
  }
  const at = (r, c) => complete.find((p) => p.cell.row === r && p.cell.column === c),
    lines = (ff) => {
      const out = [],
        h = Math.max(...ff.map((f) => f.height))
      for (const f of [...ff].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
        if (Math.abs(f.height - h) > h * 0.05) return []
        if (out.length && Math.abs(out.at(-1)[0].baseline - f.baseline) < h * 0.1)
          out.at(-1).push(f)
        else out.push([f])
      }
      return out
    },
    lo = (ff) => Math.min(...ff.map((f) => f.sourceItem.index)),
    hi = (ff) => Math.max(...ff.map((f) => f.sourceItem.index)),
    closed = (ff) => {
      const begin = lo(ff),
        end = hi(ff)
      return inventory.every(
        (f) =>
          !f.text?.trim() ||
          f.sourceItem.index < begin ||
          f.sourceItem.index > end ||
          (byOrigin.get(key(f.sourceItem)) === f &&
            claims.get(key(f.sourceItem)) === 1 &&
            table.cells.some(
              (c) =>
                !c.sourceSegments?.length &&
                c.sourceItems?.some((o) => key(o) === key(f.sourceItem) && o.text === f.text)
            ))
      )
    },
    wholeRows = complete.filter(
      (p) => p.cell.row > 0 && p.cell.column === 0 && lines(p.fonts).length === 1
    ),
    heads = complete.filter((p) => p.cell.row === 0)
  function inspectMergedNativeRecords() {
    // Two complete native row packets cross the same published model row.
    for (const stub of complete.filter((p) => p.cell.row > 0 && p.cell.column === 0)) {
      const bands = lines(stub.fonts),
        h = stub.fonts[0].height
      if (
        bands.length !== 2 ||
        bands.some((b) => !/\p{L}{2}/u.test(b.map((f) => f.text).join(''))) ||
        bands[1][0].baseline - bands[0][0].baseline < h ||
        hi(bands[0]) >= lo(bands[1]) ||
        wholeRows.filter(
          (p) =>
            p.cell.row !== stub.cell.row &&
            complete.filter(
              (q) =>
                q.cell.row === p.cell.row &&
                q.cell.column > 0 &&
                lo(q.fonts) > hi(p.fonts) &&
                Math.abs(Math.min(...q.fonts.map((f) => f.baseline)) - p.fonts[0].baseline) <
                  h * 0.1
            ).length >= 2
        ).length < 2
      )
        continue
      const peers = complete.filter((p) => p.cell.row === stub.cell.row && p.cell.column > 0),
        split = []
      for (const p of peers) {
        const a = p.fonts.filter((f) => f.baseline < bands[1][0].baseline - h * 0.2),
          b = p.fonts.filter((f) => f.baseline >= bands[1][0].baseline - h * 0.2)
        if (
          !a.length ||
          !b.length ||
          lo(a) <= hi(bands[0]) ||
          hi(a) >= lo(bands[1]) ||
          lo(b) <= hi(bands[1]) ||
          Math.abs(Math.min(...a.map((f) => f.baseline)) - bands[0][0].baseline) > h * 0.1 ||
          Math.abs(Math.min(...b.map((f) => f.baseline)) - bands[1][0].baseline) > h * 0.1
        )
          continue
        split.push(p)
      }
      const packet = inventory.filter(
        (f) =>
          f.sourceItem.index >= lo(stub.fonts) &&
          f.sourceItem.index <=
            Math.max(...peers.flatMap((p) => p.fonts.map((f) => f.sourceItem.index)))
      )
      const known = new Set([stub, ...peers].flatMap((p) => p.fonts.map((f) => key(f.sourceItem))))
      if (
        split.length >= 2 &&
        packet.every((f) => !f.text?.trim() || known.has(key(f.sourceItem))) &&
        closed([stub, ...peers].flatMap((p) => p.fonts))
      )
        tags.add('native-independent-row-packets-merged')
    }
  }

  function inspectSplitWrappedRecords() {
    // A complete column packet continues across a blank-stub model row before
    // the next column starts. Nearby intact wrapped records calibrate the layout.
    for (const stub of wholeRows) {
      const r = stub.cell.row,
        h = stub.fonts[0].height,
        lower = table.cells.find((c) => c.row === r + 1 && c.column === 0)
      if (
        !lower ||
        lower.text?.trim() ||
        lower.sourceItems?.length ||
        lower.sourceSegments?.length ||
        !heads.length
      )
        continue
      const pairs = []
      for (let c = 1; c < table.grid[0].length; c++) {
        const a = at(r, c),
          b = at(r + 1, c)
        if (
          !a ||
          !b ||
          hi(a.fonts) >= lo(b.fonts) ||
          Math.min(...b.fonts.map((f) => f.baseline)) <
            Math.max(...a.fonts.map((f) => f.baseline)) + h * 0.5
        )
          continue
        pairs.push({ a, b, c })
      }
      const ordered = pairs.filter(
        (p, i) => i === 0 || hi([...pairs[i - 1].a.fonts, ...pairs[i - 1].b.fonts]) < lo(p.a.fonts)
      )
      if (ordered.length < 2) continue
      const calibrated = wholeRows.some((q) => {
        if (q === stub || q.cell.row === r + 1) return false
        const paragraphs = ordered.map((p) => at(q.cell.row, p.c))
        if (paragraphs.some((p) => !p)) return false
        const reference = paragraphs.map((p) => lines(p.fonts))
        if (
          reference.some((ll) => ll.length < 2) ||
          new Set(reference.map((ll) => ll.length)).size !== 1
        )
          return false
        const step = reference[0][1][0].baseline - reference[0][0][0].baseline
        if (step < h * 0.9 || step > h * 1.5) return false
        if (
          reference.some((ll, c) => {
            const target = lines([...ordered[c].a.fonts, ...ordered[c].b.fonts])
            return (
              target.length < 2 ||
              Math.abs(ll[0][0].baseline - q.fonts[0].baseline) > h * 0.05 ||
              Math.abs(target[0][0].baseline - stub.fonts[0].baseline) > h * 0.05 ||
              [...ll, ...target].some((line) =>
                line.some(
                  (f) =>
                    Math.abs(f.height - h) > h * 0.02 ||
                    Math.abs(f.rect[0] - ll[0][0].rect[0]) > h * 0.1
                )
              ) ||
              [ll, target].some((bands) =>
                bands
                  .slice(1)
                  .some(
                    (line, i) => Math.abs(line[0].baseline - bands[i][0].baseline - step) > h * 0.02
                  )
              )
            )
          })
        )
          return false
        if (
          lo(paragraphs[0].fonts) <= hi(q.fonts) ||
          paragraphs.slice(1).some((p, i) => lo(p.fonts) <= hi(paragraphs[i].fonts))
        )
          return false
        return closed([q, ...paragraphs].flatMap((p) => p.fonts))
      })
      if (!calibrated) continue

      const last = Math.max(
          ...ordered.flatMap((p) => [...p.a.fonts, ...p.b.fonts].map((f) => f.sourceItem.index))
        ),
        packet = inventory.filter(
          (f) => f.sourceItem.index >= lo(stub.fonts) && f.sourceItem.index <= last
        ),
        known = new Set(
          complete
            .filter((p) => p.cell.row === r || p.cell.row === r + 1)
            .flatMap((p) => p.fonts.map((f) => key(f.sourceItem)))
        )
      if (
        packet.every((f) => !f.text?.trim() || known.has(key(f.sourceItem))) &&
        closed(
          complete.filter((p) => p.cell.row === r || p.cell.row === r + 1).flatMap((p) => p.fonts)
        )
      )
        tags.add('native-wrapped-column-packet-split-across-rows')
    }
  }

  function inspectPrecedingRecordTails() {
    // A tail emitted before the next stub and before an independent preceding
    // field cannot start the next top-aligned native record.
    for (const stub of wholeRows) {
      const h = stub.fonts[0].height,
        y = stub.fonts[0].baseline,
        previous = wholeRows.filter((p) => p.cell.row < stub.cell.row).at(-1)
      if (!previous || wholeRows.length < 3 || heads.length < 3) continue
      for (const p of complete.filter((p) => p.cell.row === stub.cell.row && p.cell.column > 0)) {
        const tail = p.fonts.filter((f) => f.sourceItem.index < lo(stub.fonts)),
          rest = p.fonts.filter((f) => f.sourceItem.index > hi(stub.fonts)),
          prior = at(previous.cell.row, p.cell.column)
        if (
          !tail.length ||
          !rest.length ||
          !prior ||
          tail.some((f) => Math.abs(f.height - h) > h * 0.05 || f.baseline >= y - h * 0.8) ||
          Math.abs(Math.min(...rest.map((f) => f.baseline)) - y) > h * 0.1 ||
          hi(prior.fonts) >= lo(tail) ||
          Math.min(...tail.map((f) => f.baseline)) -
            Math.max(...prior.fonts.map((f) => f.baseline)) >
            h * 1.5
        )
          continue
        const later = complete.find(
          (q) =>
            q.cell.row === previous.cell.row &&
            q.cell.column > p.cell.column &&
            lo(q.fonts) > hi(tail) &&
            hi(q.fonts) < lo(stub.fonts)
        )
        const packet = complete
          .filter((q) => q.cell.row === previous.cell.row || q.cell.row === stub.cell.row)
          .flatMap((q) => q.fonts)
        if (later && closed(packet)) tags.add('native-prior-record-tail-assigned-to-next-row')
      }
    }
  }

  // An equality anchors its own physical line even when native subscripts and
  // exponents use smaller fonts. Repeated parallel assignments establish only
  // a row contradiction, never a replacement grid or a corrected variable.
  function inspectParallelAssignments() {
    if (
      table.grid[0]?.length !== 2 ||
      table.grid.length < 3 ||
      table.grid.length > 128 ||
      inventory.length > 4096 ||
      rules.length > 4096 ||
      complete.length !== table.grid.length * 2
    )
      return
    const assignment = (p) => {
      const h = Math.max(...p.fonts.map((f) => f.height)),
        equals = p.fonts.filter((f) => f.text === '=').sort((a, b) => a.baseline - b.baseline)
      if (!equals.length || equals.length > 2) return
      const groups = equals.map((eq) => ({ eq, fonts: [] }))
      for (const f of p.fonts) {
        const ranked = groups
          .map((g) => ({ g, distance: Math.abs(g.eq.baseline - f.baseline) }))
          .sort((a, b) => a.distance - b.distance)
        if (
          ranked[0].distance > h * 0.5 ||
          (ranked[1] && ranked[1].distance - ranked[0].distance < h * 0.1) ||
          f.height < h * 0.45 ||
          f.height > h * 1.02
        )
          return
        ranked[0].g.fonts.push(f)
      }
      for (const g of groups) {
        const left = g.fonts.filter((f) => f !== g.eq && f.rect[2] <= g.eq.rect[0]),
          right = g.fonts.filter((f) => f !== g.eq && f.rect[0] >= g.eq.rect[2])
        g.label = compact(left.map((f) => f.text).join(''))
        if (
          left.length + right.length + 1 !== g.fonts.length ||
          !/^[\p{L}\p{N}]+$/u.test(g.label) ||
          !right.some((f) => /\d/u.test(f.text))
        )
          return
      }
      return { h, groups }
    }
    const rows = []
    for (let r = 0; r < table.grid.length; r++) {
      const pair = [at(r, 0), at(r, 1)]
      if (pair.some((p) => !p)) return
      const aa = pair.map(assignment)
      if (
        aa.some((a) => !a) ||
        aa[0].groups.length !== aa[1].groups.length ||
        aa[0].groups.some(
          (g, i) => Math.abs(g.eq.baseline - aa[1].groups[i].eq.baseline) > aa[0].h * 0.05
        )
      )
        return
      rows.push(aa)
    }
    if (rows.filter((aa) => aa[0].groups.length === 2).length !== 1) return
    const h = Math.max(...rows.flatMap((aa) => aa.map((a) => a.h))),
      ys = rows.flatMap((aa) => aa[0].groups.map((g) => g.eq.baseline)),
      step = ys[1] - ys[0],
      ff = complete.flatMap((p) => p.fonts),
      box = bounds(ff),
      horizontal = rules.filter((r) => rect(r) && r[1] === r[3] && r[0] <= box[0] && r[2] >= box[2])
    if (
      step < h * 0.9 ||
      step > h * 1.6 ||
      ys.slice(1).some((y, i) => Math.abs(y - ys[i] - step) > h * 0.08) ||
      [0, 1].some((c) => {
        const labels = rows.flatMap((aa) => aa[c].groups.map((g) => g.label))
        return new Set(labels).size !== labels.length
      }) ||
      !horizontal.some((r) => r[1] < box[1] && box[1] - r[1] < h * 2) ||
      !horizontal.some((r) => r[1] > box[3] && r[1] - box[3] < h * 2) ||
      !closed(ff)
    )
      return
    tags.add('native-parallel-assignment-rows-collapsed')
  }

  function inspectWrappedHierarchy() {
    if (
      table.grid[0]?.length !== 3 ||
      !heads.length ||
      complete.length > 4096 ||
      inventory.length > 4096 ||
      rules.length > 4096
    )
      return
    let glyphRecords
    for (const upper of wholeRows) {
      const r = upper.cell.row,
        lower = at(r + 1, 0),
        a = [at(r, 1), at(r, 2)],
        b = [at(r + 1, 1), at(r + 1, 2)]
      if (
        upper.fonts.length !== 1 ||
        !/\p{L}.*&\s*$/u.test(upper.cell.text) ||
        !lower ||
        lower.fonts.length !== 1 ||
        !/^\p{L}+$/u.test(lower.cell.text.trim()) ||
        a.some((p) => !p || p.fonts.length !== 1) ||
        b.some((p) => !p || p.fonts.length !== 2)
      )
        continue
      const start = upper.fonts[0],
        end = lower.fonts[0],
        h = start.height,
        step = end.baseline - start.baseline,
        ff = [upper, lower, ...a, ...b].flatMap((p) => p.fonts),
        nativeFont = font(start).fontName
      if (
        step < h ||
        step > h * 1.5 ||
        Math.abs(start.rect[0] - end.rect[0]) > h * 0.02 ||
        ff.some((f) => Math.abs(f.height - h) > h * 0.02 || font(f).fontName !== nativeFont) ||
        a.some((p, c) => {
          const first = p.fonts[0],
            [tail, next] = b[c].fonts
          return (
            Math.abs(first.baseline - start.baseline) > h * 0.02 ||
            Math.abs(tail.baseline - end.baseline) > h * 0.02 ||
            Math.abs(next.baseline - end.baseline - step) > h * 0.02 ||
            Math.abs(first.rect[0] - tail.rect[0]) > h * 0.02 ||
            Math.abs(first.rect[0] - next.rect[0]) > h * 0.02 ||
            first.sourceItem.index >= tail.sourceItem.index ||
            tail.sourceItem.index >= next.sourceItem.index
          )
        }) ||
        !closed(ff)
      )
        continue
      const box = bounds(ff),
        envelopes = inventory
          .filter((f) => f.text?.trim())
          .map((f) => ({ envelope: f.nativeLabelRect ?? f.rect })),
        edges = rules.filter(
          (edge) =>
            rect(edge) &&
            edge[1] === edge[3] &&
            edge[0] <= box[0] &&
            edge[2] >= box[2] &&
            visibleNativeHeaderRule(edge, context, envelopes)
        ),
        top = edges.filter((edge) => edge[1] < box[1]),
        bottom = edges.filter((edge) => edge[1] > box[3])
      if (!top.length || !bottom.length) continue
      glyphRecords ??= new Map(
        nativeNumberedRecordGlyphFonts(table, context).map((q) => [q.index, q])
      )
      const scale = context.viewport.scale,
        rightEdge = Math.min(...bottom.map((edge) => edge[2]))
      const forced = a.every((p, c) => {
        const tail = b[c].fonts[0],
          record = glyphRecords.get(tail.sourceItem.index),
          word = tail.text.trim().match(/^\S+/u)?.[0],
          parts = record?.part.slice(0, [...(word ?? '')].length),
          limit = c === 0 ? a[1].fonts[0].rect[0] : rightEdge
        if (!word || !parts?.length || parts.map((p) => p.c).join('') !== word) return false
        const width =
          (Math.max(...parts.map((p) => p.g.advance[2])) -
            Math.min(...parts.map((p) => p.g.advance[0]))) *
          scale
        return p.fonts[0].rect[2] + width > limit + h * 0.05
      })
      if (forced) tags.add('native-wrapped-hierarchy-crosses-record-row')
    }
  }

  inspectParallelAssignments()
  inspectWrappedHierarchy()
  inspectMergedNativeRecords()
  inspectSplitWrappedRecords()
  inspectPrecedingRecordTails()
  return [...tags]
}

function nativeCalibratedValueLaneSplit(table, inventory, font) {
  const source = new Map(),
    claims = new Map(),
    tags = new Set()
  for (const f of inventory) {
    if (!f.sourceItem) continue
    const k = key(f.sourceItem)
    source.set(k, source.has(k) || !canonicalNativeFont(f) || !font(f) ? undefined : f)
  }
  for (const cell of table.cells)
    for (const origin of cell.sourceItems ?? []) {
      const k = key(origin)
      claims.set(k, [...(claims.get(k) ?? []), cell])
    }
  const scalarPair = (s) =>
    /^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)\s*\[\s*[+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*,\s*[+−-]?(?:\d+(?:\.\d+)?|\.\d+))?\s*\]$/u.test(
      s.trim()
    )
  const singleSource = (cell) =>
    cell &&
    cell.rowSpan === 1 &&
    cell.colSpan === 1 &&
    !cell.sourceSegments?.length &&
    cell.sourceItems?.length === 1 &&
    cell.sourceRects?.length === 1 &&
    rect(cell.sourceRects[0])
  const whole = (cell) => {
    if (!singleSource(cell)) return
    const f = source.get(key(cell.sourceItems[0]))
    return f &&
      f.text === cell.sourceItems[0].text &&
      same(f.rect, cell.sourceRects[0]) &&
      compact(cell.text) === compact(f.text) &&
      claims.get(key(f.sourceItem))?.length === 1
      ? f
      : undefined
  }
  const partitions = []
  for (const [origin, cells] of claims) {
    if (cells.length !== 2 || cells[0] === cells[1] || !cells.every(singleSource)) continue
    const [left, right] = [...cells].sort((a, b) => a.column - b.column),
      f = source.get(origin)
    if (
      !f ||
      left.row !== right.row ||
      left.column + 1 !== right.column ||
      cells.some((c) => c.sourceItems[0].text !== f.text) ||
      compact(left.text + right.text) !== compact(f.text)
    )
      continue
    const [a, b] = [left.sourceRects[0], right.sourceRects[0]]
    if (
      !same([a[0], a[1], b[2], b[3]], f.rect) ||
      Math.abs(a[2] - b[0]) > 1e-6 ||
      a[0] >= a[2] ||
      b[0] >= b[2] ||
      Math.abs(a[1] - b[1]) > 1e-6 ||
      Math.abs(a[3] - b[3]) > 1e-6
    )
      continue
    partitions.push({ left, right, font: f, cut: a[2] })
  }
  for (const p of partitions) {
    inspectEmptyHeaderLane(p)
    inspectRepeatedValueLane(p)
  }
  function inspectEmptyHeaderLane({ left, right, font: f, cut }) {
    if (left.row <= 0 || !/\p{L}{2}/u.test(f.text)) return
    const values = table.cells
      .filter(
        (c) =>
          c.row > left.row &&
          c.column === left.column &&
          c.rowSpan === 1 &&
          c.colSpan === 1 &&
          !c.sourceSegments?.length &&
          c.sourceItems?.length &&
          c.sourceRects?.length === c.sourceItems.length
      )
      .flatMap((cell) => {
        const ff = cell.sourceItems.map((o) => source.get(key(o)))
        if (
          ff.some(
            (g, i) =>
              !g ||
              g.text !== cell.sourceItems[i].text ||
              claims.get(key(g.sourceItem))?.length !== 1 ||
              cell.sourceRects.filter((r) => same(r, g.rect)).length !== 1
          ) ||
          compact(cell.text) !== compact(ff.map((g) => g.text).join(''))
        )
          return []
        const empty = table.cells.find((c) => c.row === cell.row && c.column === right.column)
        return empty &&
          !empty.text?.trim() &&
          !empty.sourceItems?.length &&
          !empty.sourceSegments?.length
          ? ff.filter((g) => scalarPair(g.text) && g.rect[0] < cut && g.rect[2] > cut)
          : []
      })
    if (values.length >= 3) tags.add('native-whole-header-split-into-empty-value-lane')
  }
  function inspectRepeatedValueLane({ left, right, font: f, cut }) {
    if (
      left.row === 0 ||
      !scalarPair(f.text) ||
      table.cells.some(
        (c) =>
          c.row === 0 &&
          c.colSpan > 1 &&
          c.column <= left.column &&
          c.column + c.colSpan > right.column
      )
    )
      return
    const head = table.cells.find((c) => c.row === 0 && c.column === right.column),
      empty = table.cells.find((c) => c.row === 0 && c.column === left.column),
      hf = whole(head)
    if (
      !hf ||
      empty?.text?.trim() ||
      empty?.sourceItems?.length ||
      empty?.sourceSegments?.length ||
      hf.rect[0] >= cut ||
      hf.rect[2] <= cut
    )
      return
    const peers = table.cells
      .filter((c) => c.row === left.row && c.column < left.column)
      .map(whole)
      .filter((g) => g && scalarPair(g.text) && Math.abs(g.baseline - f.baseline) < f.height * 0.05)
    const repeats = partitions.filter(
      (p) =>
        p.left.row > 0 &&
        p.left.column === left.column &&
        p.right.column === right.column &&
        scalarPair(p.font.text)
    )
    if (peers.length >= 2 && repeats.length >= 3)
      tags.add('native-single-value-lane-published-as-two-leaves')
  }
  return [...tags]
}

// Only native record ownership is tested here; these rules do not prove crop ink.
const printedOneLine = (ff) =>
  ff.length && ff.every((f) => Math.abs(f.baseline - ff[0].baseline) < ff[0].height * 0.05)
function nativePrintedRecordConflicts(table, owned, inventory, rules, font, context, fontEnvelope) {
  if (
    table.cells.length > 4096 ||
    inventory.length > 4096 ||
    rules.length > 4096 ||
    table.cells.reduce((n, c) => n + (c.sourceItems?.length ?? 0), 0) > 4096
  )
    return []
  const whole = owned.filter(
      (p) =>
        p.fonts.length &&
        p.fonts.every((f) => font(f)) &&
        compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join(''))
    ),
    leaves = whole.filter((p) => p.cell.rowSpan === 1 && p.cell.colSpan === 1),
    horizontal = rules.filter((r) => rect(r) && r[1] === r[3] && r[2] > r[0]),
    reasons = []
  const counts = new Map()
  for (const c of table.cells)
    for (const o of c.sourceItems ?? [])
      counts.set(`${o.pageNumber}:${o.index}`, (counts.get(`${o.pageNumber}:${o.index}`) ?? 0) + 1)
  const closed = (ff) => {
    const ids = new Set(ff.map((f) => key(f.sourceItem))),
      lo = Math.min(...ff.map((f) => f.sourceItem.index)),
      hi = Math.max(...ff.map((f) => f.sourceItem.index))
    return (
      ff.every((f) => counts.get(key(f.sourceItem)) === 1) &&
      inventory.every(
        (f) =>
          !f.text?.trim() ||
          f.sourceItem.index < lo ||
          f.sourceItem.index > hi ||
          ids.has(key(f.sourceItem))
      )
    )
  }
  reasons.push(
    ...nativeRowspanPrintedDividerConflicts(
      table,
      owned,
      inventory,
      rules,
      font,
      context,
      fontEnvelope,
      visibleNativeHeaderRule
    )
  )
  // Two native headings and both numerical lanes are independently right
  // aligned. Do not infer an invisible column from a long single heading.
  for (const head of leaves.filter(
    (p) => p.cell.row === 0 && p.fonts.length === 2 && printedOneLine(p.fonts)
  )) {
    const [a, b] = [...head.fonts].sort((a, b) => a.rect[0] - b.rect[0]),
      h = a.height
    if (
      ![a, b].every((f) => /^\p{L}{2,}$/u.test(f.text.trim())) ||
      b.rect[0] - a.rect[2] < h * 0.6 ||
      Math.abs(a.height - b.height) > h * 0.02
    )
      continue
    const pairs = leaves
      .filter(
        (p) =>
          p.cell.row > 0 &&
          p.cell.column === head.cell.column &&
          p.fonts.length === 2 &&
          printedOneLine(p.fonts)
      )
      .map((p) => ({ p, ff: [...p.fonts].sort((a, b) => a.rect[0] - b.rect[0]) }))
    if (
      pairs.length < 3 ||
      pairs.some(
        ({ ff: [l, r] }) =>
          ![l, r].every(
            (f) => /^[+−-]?\d+(?:\.\d+)?$/u.test(f.text.trim()) && Math.abs(f.height - h) < h * 0.02
          ) ||
          r.rect[0] - l.rect[2] < h ||
          Math.abs(l.rect[2] - a.rect[2]) > h * 0.02 ||
          Math.abs(r.rect[2] - b.rect[2]) > h * 0.02
      )
    )
      continue
    const packet = [...head.fonts, ...pairs.flatMap(({ ff }) => ff)],
      box = bounds(packet),
      originRight = Math.max(...packet.map((f) => f.rect[0]))
    if (
      !horizontal.some((r) => r[0] <= box[0] && r[2] >= originRight && r[1] < box[1]) ||
      !horizontal.some((r) => r[0] <= box[0] && r[2] >= originRight && r[1] > box[3])
    )
      continue
    const envelopes = inventory
      .filter((f) => f.text?.trim())
      .map((f) => ({ envelope: fontEnvelope(f) }))
    if (envelopes.some((f) => !rect(f.envelope))) continue
    const visible = horizontal.filter((r) => visibleNativeHeaderRule(r, context, envelopes))
    if (
      !visible.some((r) => r[0] <= box[0] && r[2] >= originRight && r[1] < box[1]) ||
      !visible.some((r) => r[0] <= box[0] && r[2] >= originRight && r[1] > box[3])
    )
      continue
    const calibrated = pairs.filter(
      ({ p, ff }) =>
        closed(ff) &&
        leaves.some(
          (q) =>
            q.cell.row === p.cell.row &&
            q.cell.column < head.cell.column &&
            printedOneLine(q.fonts) &&
            q.box[2] < ff[0].rect[0] - h
        )
    )
    if (
      calibrated.some(({ p }) =>
        [1, 2].every((d) => calibrated.some((q) => q.p.cell.row === p.cell.row + d))
      )
    )
      reasons.push('native-right-aligned-headed-numeric-lanes-collapsed')
  }
  return [...new Set(reasons)]
}
