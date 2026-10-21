/* eslint-disable @typescript-eslint/explicit-function-return-type */
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

export function nativeTableLayoutConflicts(table, inventory, rules = []) {
  if (!table?.cells?.length || !table.grid?.length || !rect(table.cropRect)) return []
  const native = new Map(),
    owners = new Map(),
    conflicts = new Set()
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
  if (displaced.size >= 2) conflicts.add('stub-continuation-crosses-record-row')
  for (const r of horizontal) {
    const first = leaves.filter((p) => p.cell.row === 0),
      all = first.flatMap((p) => p.fonts)
    if (
      first.length >= 3 &&
      all.length &&
      r[0] <= Math.min(...all.map((f) => f.rect[0])) &&
      r[2] >= Math.max(...all.map((f) => f.rect[2])) &&
      first.every(
        (p) => p.fonts.some((f) => f.baseline < r[1]) && p.fonts.some((f) => f.rect[1] > r[1])
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
