/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeTextShowSourceMarkers } from './literature-pdf-native-leaf-record-repair.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

const number = /^[−–-]?\d+\.\d+$/

// Split only an already-owned terminal packet. Native reading order corroborates
// complete geometric slots; neither an outer rule nor a tall model row proves a
// record by itself. This never adopts unassigned text or clears diagnostics.
export function recoverNativeFooterRecordRows(result, items, captions, rules, recordText, context) {
  const count = result.grid[0]?.length,
    valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
    intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    key = (o) => `${o.pageNumber}:${o.index}`,
    same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
    compact = (s) => s.replace(/\s/gu, '')
  if (
    count < 3 ||
    count > 12 ||
    !valid(result.cropRect) ||
    result.grid.length < 3 ||
    items.some((i) => i.text?.trim() && !valid(i.rect))
  )
    return
  const plans = []
  for (const row of [result.grid.length - 2, result.grid.length - 1]) {
    const donors = result.cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
    if (
      donors.length !== count ||
      donors.some(
        (c, n) =>
          c.column !== n ||
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          !valid(c.rect) ||
          c.sourceSegments ||
          !c.sourceItems?.length ||
          c.textRuns?.length ||
          (n && c.rect[0] !== donors[n - 1].rect[2])
      ) ||
      result.cells.some((c) => c.row < row && c.row + c.rowSpan > row)
    )
      continue
    const fields = donors.map((c) =>
      c.sourceItems.map((o) => items.filter((i) => i.sourceItem && same(i.sourceItem, o)))
    )
    if (fields.some((g) => g.some((matches) => matches.length !== 1))) continue
    const fonts = fields.map((g) => g.map((matches) => matches[0])),
      all = fonts.flat(),
      h = all[0]?.height
    if (
      !proveNativeUniqueWholeFonts(all, items) ||
      !Number.isFinite(h) ||
      !(h > 0) ||
      new Set(all.map((i) => i.sourceItem.pageNumber)).size !== 1 ||
      all.some(
        (i) => Math.abs(i.height - h) > h * 0.02 || i.baseline < i.rect[1] || i.baseline > i.rect[3]
      )
    )
      continue
    const owned = new Set(all.map((i) => key(i.sourceItem)))
    if (
      result.cells
        .filter((c) => !donors.includes(c))
        .some((c) =>
          [...(c.sourceItems ?? []), ...(c.sourceSegments ?? [])].some((o) => owned.has(key(o)))
        )
    )
      continue
    if (
      fonts.some(
        (g, c) =>
          g.some((i) => i.rect[0] < donors[c].rect[0] || i.rect[2] > donors[c].rect[2]) ||
          !same(g.map((i) => i.rect).sort(), [...(donors[c].sourceRects ?? [])].sort()) ||
          compact(recordText(g)) !== compact(donors[c].text)
      )
    )
      continue
    const bounds = box(all),
      scope = [donors[0].rect[0], bounds[1], donors.at(-1).rect[2], bounds[3]]
    if (
      scope.some((v, n) => (n < 2 ? v < result.cropRect[n] : v > result.cropRect[n])) ||
      items.some(
        (i) => i.text?.trim() && valid(i.rect) && intersects(i.rect, scope) && !all.includes(i)
      ) ||
      captions.some((c) => intersects(c.rect, scope))
    )
      continue
    const bands = [
      ...Map.groupBy(
        rules.filter(
          (r) =>
            r.every(Number.isFinite) &&
            r[1] === r[3] &&
            r[0] < scope[2] &&
            r[2] > scope[0] &&
            r[1] >= result.cropRect[1] &&
            r[1] <= result.cropRect[3]
        ),
        (r) => r[1]
      ).values()
    ]
      .map((g) => [...g].sort((a, b) => a[0] - b[0]))
      .sort((a, b) => a[0][1] - b[0][1])
    if (
      bands.length !== 4 ||
      bands.some(
        (g) =>
          g.length !== count ||
          g.some(
            (r, c) =>
              r[2] - r[0] <= h * 2 ||
              (c && (r[0] <= g[c - 1][2] || r[0] - g[c - 1][2] > h * 0.2)) ||
              Math.abs(r[0] - bands[0][c][0]) > h * 0.15 ||
              Math.abs(r[2] - bands[0][c][2]) > h * 0.02 ||
              (donors[c].rect[0] + donors[c].rect[2]) / 2 <= r[0] ||
              (donors[c].rect[0] + donors[c].rect[2]) / 2 >= r[2]
          )
      )
    )
      continue
    const opening = bands[0][0][1],
      closing = bands.at(-1)[0][1]
    if (
      opening >= scope[1] ||
      closing <= scope[3] ||
      closing - scope[3] > h * 4 ||
      scope[1] <= bands[2][0][1] ||
      captions.filter(
        (c) =>
          captionKind(c.lines[0]) === 'table' &&
          c.rect[3] < opening &&
          opening - c.rect[3] < h * 3 &&
          c.rect[0] < scope[2] &&
          c.rect[2] > scope[0]
      ).length !== 1 ||
      rules.some((r) => r[0] < scope[2] && r[2] > scope[0] && r[1] < scope[3] && r[3] > scope[1])
    )
      continue
    const stubs = []
    for (const i of [...fonts[0]].sort(
      (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
    )) {
      const last = stubs.at(-1)
      if (last && Math.abs(i.baseline - last[0].baseline) < h * 0.05) last.push(i)
      else stubs.push([i])
    }
    if (
      stubs.length < 3 ||
      stubs.length > 12 ||
      stubs.some(
        (g) => !/\p{L}/u.test(recordText(g)) || Math.abs(box(g)[0] - box(stubs[0])[0]) > h * 0.05
      )
    )
      continue
    const groups = stubs.map((stub, n) =>
      fonts.map((g) =>
        g.filter(
          (i) =>
            i.baseline >= stub[0].baseline - h * 0.05 &&
            (!stubs[n + 1] || i.baseline < stubs[n + 1][0].baseline - h * 0.05)
        )
      )
    )
    if (
      groups.some((g, n) =>
        g.some(
          (f, c) =>
            !f.length ||
            !f.some((i) => Math.abs(i.baseline - stubs[n][0].baseline) < h * 0.05) ||
            (c === 0 &&
              !same(
                f,
                fonts[0].filter((i) => stubs[n].includes(i))
              ))
        )
      )
    )
      continue
    // Each wrapped field must be emitted completely before the next column,
    // and each record before the next stub. Row-major blank-stub records cannot
    // masquerade as column-local continuations under this joint proof.
    const ordered = groups.flatMap((g) =>
      g.flatMap((f) => [...f].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]))
    )
    if (
      ordered.length !== all.length ||
      new Set(ordered).size !== all.length ||
      ordered.some((i, n) => n && i.sourceItem.index <= ordered[n - 1].sourceItem.index)
    )
      continue
    if (
      !groups.some((g) => g.slice(1).every((f) => /^[+−-]?\d[\d,.]*$/.test(recordText(f)))) ||
      !groups.some((g) => g.slice(1).every((f) => /\p{L}/u.test(recordText(f))))
    )
      continue
    if (!nativeFooterTaggedRows(groups, context)) continue
    const boxes = groups.map((g) => box(g.flat()))
    if (
      boxes.some((b, n) => n && b[1] <= boxes[n - 1][3]) ||
      groups.some((g) =>
        g.some((f) => {
          const lines = [...Map.groupBy(f, (i) => i.baseline).values()].sort(
            (a, b) => a[0].baseline - b[0].baseline
          )
          return lines.some(
            (line, n) =>
              n &&
              (box(line)[1] <= box(lines[n - 1])[3] ||
                line[0].baseline - lines[n - 1][0].baseline > h * 2)
          )
        })
      )
    )
      continue
    const top = Math.min(donors[0].rect[1], bounds[1]),
      bottom = Math.max(donors[0].rect[3], bounds[3])
    if (
      top < result.cropRect[1] ||
      bottom > result.cropRect[3] ||
      result.cells
        .filter((c) => !donors.includes(c))
        .some((c) => (c.row < row ? c.rect[3] > top : c.rect[1] < bottom))
    )
      continue
    const edges = [top, ...boxes.slice(1).map((b, n) => (boxes[n][3] + b[1]) / 2), bottom]
    plans.push({ row, donors, groups, edges })
  }
  if (plans.length !== 1) return
  const { row, donors, groups, edges } = plans[0],
    replacements = groups.flatMap((g, n) =>
      g.map((fonts, c) => ({
        ...donors[c],
        row: row + n,
        rect: [donors[c].rect[0], edges[n], donors[c].rect[2], edges[n + 1]],
        text: recordText(fonts),
        sourceItems: fonts.map((i) => ({ ...i.sourceItem })).sort((a, b) => a.index - b.index),
        sourceTokens: fonts,
        sourceRects: fonts.map((i) => i.rect)
      }))
    )
  const cells = result.cells.flatMap((c) =>
    c.row === row
      ? c === donors[0]
        ? replacements
        : []
      : [{ ...c, row: c.row > row ? c.row + groups.length - 1 : c.row }]
  )
  if (
    !same(
      result.cells
        .flatMap((c) => c.sourceItems ?? [])
        .map((o) => JSON.stringify(o))
        .sort(),
      cells
        .flatMap((c) => c.sourceItems ?? [])
        .map((o) => JSON.stringify(o))
        .sort()
    )
  )
    return
  return {
    ...result,
    cells,
    grid: [
      ...result.grid.slice(0, row),
      ...groups.map((g) => g.map((fonts) => recordText(fonts))),
      ...result.grid.slice(row + 1)
    ],
    rows: [
      ...result.rows.slice(0, row),
      ...groups.map((_, n) => ({
        ...result.rows[row],
        rect: [donors[0].rect[0], edges[n], donors.at(-1).rect[2], edges[n + 1]]
      })),
      ...result.rows.slice(row + 1)
    ],
    repairs: [...result.repairs, 'native-owned-footer-records-recovered']
  }
}

// Join only an already-owned field split across two physical rows. A complete
// native TR and its exact TD source domains, bound to actual text-show operators,
// prove continuation; a blank stub or nearby baseline never proves it alone.
export function recoverNativeOwnedWrappedRow(result, items, captions, rules, recordText, context) {
  const count = result.grid[0]?.length,
    valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
    same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
    key = (o) => `${o.pageNumber}:${o.index}`,
    compact = (s) => s.replace(/\s/gu, ''),
    intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  if (
    count < 3 ||
    count > 12 ||
    !valid(result.cropRect) ||
    items.some((i) => i.text?.trim() && !valid(i.rect))
  )
    return
  const plans = []
  for (let row = 1; row < result.grid.length; row++) {
    const previous = result.cells
        .filter((c) => c.row === row - 1)
        .sort((a, b) => a.column - b.column),
      continuation = result.cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column),
      packet = [...previous, ...continuation],
      populated = continuation.filter((c) => c.text.trim())
    if (
      previous.length !== count ||
      continuation.length !== count ||
      populated.length !== 1 ||
      populated[0].column === 0 ||
      previous.some((c) => !c.text.trim()) ||
      packet.some(
        (c, n) =>
          c.column !== n % count ||
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          !valid(c.rect) ||
          c.sourceSegments ||
          c.textRuns?.length ||
          (n % count && c.rect[0] !== packet[n - 1].rect[2])
      ) ||
      previous.some(
        (c, n) => c.rect[0] !== continuation[n].rect[0] || c.rect[2] !== continuation[n].rect[2]
      ) ||
      result.cells.some((c) => c.row < row - 1 && c.row + c.rowSpan > row - 1)
    )
      continue
    const fields = packet.map((c) =>
      (c.sourceItems ?? []).map((o) => items.filter((i) => i.sourceItem && same(i.sourceItem, o)))
    )
    if (fields.some((g) => g.some((matches) => matches.length !== 1))) continue
    const fonts = fields.map((g) => g.map((matches) => matches[0])),
      all = fonts.flat(),
      h = all[0]?.height
    if (
      !proveNativeUniqueWholeFonts(all, items) ||
      !(h > 0) ||
      new Set(all.map((i) => i.sourceItem.pageNumber)).size !== 1 ||
      all.some((i) => Math.abs(i.height - h) > h * 0.02) ||
      packet.some(
        (c, n) =>
          !same([...(c.sourceRects ?? [])].sort(), fonts[n].map((i) => i.rect).sort()) ||
          compact(c.text) !== compact(recordText(fonts[n])) ||
          fonts[n].some((i) => i.rect[0] < c.rect[0] || i.rect[2] > c.rect[2])
      )
    )
      continue
    const owned = new Set(all.map((i) => key(i.sourceItem))),
      headFonts = fonts.slice(0, count).flat(),
      tailFonts = fonts.slice(count).flat(),
      headBottom = Math.max(...headFonts.map((i) => i.rect[3])),
      tailTop = Math.min(...tailFonts.map((i) => i.rect[1])),
      scope = [
        previous[0].rect[0],
        Math.min(...all.map((i) => i.rect[1])),
        previous.at(-1).rect[2],
        Math.max(...all.map((i) => i.rect[3]))
      ]
    if (
      !tailFonts.length ||
      tailTop < headBottom ||
      scope.some((v, n) => (n < 2 ? v < result.cropRect[n] : v > result.cropRect[n])) ||
      items.some((i) => i.text?.trim() && intersects(i.rect, scope) && !all.includes(i)) ||
      captions.some((c) => !valid(c.rect) || intersects(c.rect, scope)) ||
      rules.some(
        (r) =>
          !Array.isArray(r) ||
          r.length !== 4 ||
          !r.every(Number.isFinite) ||
          (r[1] === r[3] &&
            r[1] >= headBottom &&
            r[1] <= tailTop &&
            r[0] < scope[2] &&
            r[2] > scope[0])
      ) ||
      result.cells
        .filter((c) => !packet.includes(c))
        .some((c) =>
          [...(c.sourceItems ?? []), ...(c.sourceSegments ?? [])].some((o) => owned.has(key(o)))
        )
    )
      continue
    const groups = previous.map((_, c) => [...fonts[c], ...fonts[count + c]])
    if (!nativeFooterTaggedRows([groups], context)) continue
    plans.push({ row, previous, continuation, groups })
  }
  if (plans.length !== 1) return
  const { row, previous, continuation, groups } = plans[0],
    top = Math.min(...previous.map((c) => c.rect[1])),
    bottom = Math.max(...[...previous, ...continuation].map((c) => c.rect[3])),
    replacements = previous.map((c, n) => ({
      ...c,
      rect: [c.rect[0], top, c.rect[2], bottom],
      text: continuation[n].text.trim() ? recordText(groups[n]) : c.text,
      sourceItems: groups[n].map((i) => ({ ...i.sourceItem })).sort((a, b) => a.index - b.index),
      sourceRects: groups[n].map((i) => i.rect),
      sourceTokens: groups[n].map(({ text, rect, baseline, height }) => ({
        text,
        rect,
        baseline,
        height
      }))
    })),
    cells = result.cells.flatMap((c) =>
      c.row === row
        ? []
        : c.row === row - 1
          ? c === previous[0]
            ? replacements
            : []
          : [{ ...c, row: c.row > row ? c.row - 1 : c.row }]
    )
  if (
    !same(
      result.cells
        .flatMap((c) => c.sourceItems ?? [])
        .map((o) => JSON.stringify(o))
        .sort(),
      cells
        .flatMap((c) => c.sourceItems ?? [])
        .map((o) => JSON.stringify(o))
        .sort()
    )
  )
    return
  return {
    ...result,
    cells,
    grid: [
      ...result.grid.slice(0, row - 1),
      replacements.map((c) => c.text),
      ...result.grid.slice(row + 1)
    ],
    rows: [
      ...result.rows.slice(0, row - 1),
      {
        ...result.rows[row - 1],
        rect: [previous[0].rect[0], top, previous.at(-1).rect[2], bottom]
      },
      ...result.rows.slice(row + 1)
    ],
    repairs: [...result.repairs, 'native-owned-wrapped-row-recovered']
  }
}

// Geometry and text-stream order cannot distinguish a row-major multiline cell
// from independent records. Require the PDF's own separate TR/TH/TD domains,
// bound to the same complete text and marked operator sequence as these fonts.
function nativeFooterTaggedRows(groups, context) {
  try {
    if (
      !context ||
      ['nativeMarkedSource', 'sourceContent', 'operators', 'viewport'].some(
        (k) => !Object.hasOwn(Object.getOwnPropertyDescriptor(context, k) ?? {}, 'value')
      )
    )
      return false
    const marked = context?.nativeMarkedSource,
      content = context?.sourceContent,
      operators = context?.operators,
      viewport = context?.viewport,
      same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
      identity = (o) => `${o.pageNumber}:${o.index}`
    if (
      !marked?.structureTree ||
      !Array.isArray(marked.markedContent?.items) ||
      !Array.isArray(content?.items) ||
      !Array.isArray(operators?.fnArray) ||
      !Array.isArray(operators.argsArray) ||
      operators.fnArray.length !== operators.argsArray.length ||
      operators.fnArray.length > 100000 ||
      !viewport
    )
      return false
    let entries = 0
    const plain = (value, parents = new Set(), depth = 0) => {
      if (++entries > 200000 || depth > 64) return false
      if (value === null || typeof value !== 'object') return typeof value !== 'function'
      if (
        parents.has(value) ||
        (!Array.isArray(value) &&
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null)
      )
        return false
      const next = new Set(parents)
      next.add(value)
      return Reflect.ownKeys(value).every((k) => {
        const d = Object.getOwnPropertyDescriptor(value, k)
        return typeof k === 'string' && Object.hasOwn(d, 'value') && plain(d.value, next, depth + 1)
      })
    }
    if (!plain(marked.structureTree) || !plain(marked.markedContent.items) || !plain(content.items))
      return false
    const raw = content.items.filter((i) => typeof i.str === 'string'),
      stack = [],
      events = [],
      byId = new Map(),
      numericIds = new Set(),
      sourceMarked = new Map(),
      originals = new Map()
    let cursor = 0
    for (const item of marked.markedContent.items) {
      if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
        const match =
          item.id == null ? null : typeof item.id === 'string' && /^.+_mc(\d+)$/u.exec(item.id)
        if (
          typeof item.tag !== 'string' ||
          (item.id != null && (!match || !Number.isSafeInteger(+match[1]) || byId.has(item.id))) ||
          (item.type === 'beginMarkedContent' && match) ||
          (!match && item.tag !== 'Artifact') ||
          stack.length >= 32
        )
          return false
        const numeric = match ? +match[1] : null
        // The operator API carries numeric MCIDs without an object namespace.
        // Distinct full IDs sharing a number therefore cannot be bound safely.
        if (numeric !== null && numericIds.has(numeric)) return false
        if (numeric !== null) numericIds.add(numeric)
        if (match) byId.set(item.id, [])
        stack.push(item.id ?? null)
        events.push({ type: item.type, tag: item.tag, numeric })
      } else if (item.type === 'endMarkedContent') {
        if (!stack.length) return false
        stack.pop()
        events.push({ type: item.type })
      } else if (typeof item.str === 'string') {
        const original = raw[cursor++],
          { sourceItem, ...literal } = original ?? {}
        if (
          !sourceItem ||
          !same(literal, item) ||
          sourceItem.index !== content.items.indexOf(original) ||
          originals.has(identity(sourceItem))
        )
          return false
        originals.set(identity(sourceItem), original)
        const id = stack.findLast((id) => id !== null)
        sourceMarked.set(identity(sourceItem), id === undefined ? null : +/_mc(\d+)$/u.exec(id)[1])
        if (id !== undefined && item.str.trim()) byId.get(id).push(sourceItem)
      } else return false
    }
    if (cursor !== raw.length || stack.length) return false
    const operatorEvents = []
    for (let n = 0; n < operators.fnArray.length; n++) {
      const code = operators.fnArray[n],
        args = operators.argsArray[n]
      if (code === OPS.beginMarkedContentProps)
        operatorEvents.push({
          type: 'beginMarkedContentProps',
          tag: args?.[0],
          numeric: args?.[1] ?? null
        })
      else if (code === OPS.beginMarkedContent)
        operatorEvents.push({ type: 'beginMarkedContent', tag: args?.[0]?.name, numeric: null })
      else if (code === OPS.endMarkedContent) operatorEvents.push({ type: 'endMarkedContent' })
    }
    if (!same(events, operatorEvents)) return false
    for (const font of groups.flat(2)) {
      const original = originals.get(identity(font.sourceItem))
      if (
        !original ||
        !same(original.sourceItem, font.sourceItem) ||
        original.str !== font.text ||
        !Array.isArray(original.transform) ||
        original.transform.length !== 6 ||
        !original.transform.every(Number.isFinite) ||
        original.dir !== 'ltr'
      )
        return false
      const v = viewport.transform,
        t = original.transform
      if (
        !Array.isArray(v) ||
        v.length !== 6 ||
        !v.every(Number.isFinite) ||
        v[0] <= 0 ||
        v[1] !== 0 ||
        v[2] !== 0 ||
        v[3] !== -v[0] ||
        t[0] <= 0 ||
        t[1] !== 0 ||
        Math.abs(t[2]) > Math.abs(t[3]) * 0.5 ||
        !(original.height > 0) ||
        !(original.width > 0)
      )
        return false
      const x = t[4] * v[0] + v[4],
        baseline = t[5] * v[3] + v[5],
        height = original.height * v[0],
        rect = [x, baseline - height, x + original.width * v[0], baseline]
      if (
        !same(rect, font.rect) ||
        baseline !== font.baseline ||
        height !== font.height ||
        !font.horizontal
      )
        return false
    }
    const transform = viewport.transform,
      projection = {
        ...viewport,
        convertToViewportPoint: (x, y) => [
          x * transform[0] + y * transform[2] + transform[4],
          x * transform[1] + y * transform[3] + transform[5]
        ]
      },
      wholeFonts = raw.filter((i) => i.str.trim()).map((i) => tableTextToken(i, projection, 0)),
      markerOwners = nativeTextShowSourceMarkers(content, operators, viewport, wholeFonts, marked)
    if (
      !markerOwners ||
      markerOwners.length !== wholeFonts.length ||
      markerOwners.some((o) => sourceMarked.get(identity(o.sourceItem)) !== o.mcid)
    )
      return false
    const tables = [],
      seen = new Set(),
      contentIds = new Set()
    let nodes = 0
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 64 || ++nodes > 10000 || seen.has(node))
        throw Error('unknown tagged tree')
      seen.add(node)
      if (node.type === 'content') {
        if (typeof node.id !== 'string' || contentIds.has(node.id) || !byId.has(node.id))
          throw Error('duplicate or missing tagged content')
        contentIds.add(node.id)
      }
      if (node.role === 'Table') tables.push(node)
      if (node.children !== undefined) {
        if (!Array.isArray(node.children)) throw Error('unknown tagged children')
        for (const child of node.children) walk(child, depth + 1)
      }
    }
    walk(marked.structureTree)
    const expected = groups.map((g) => g.map((f) => f.map((i) => identity(i.sourceItem)).sort())),
      matches = []
    const gather = (node) => {
      if (node.type === 'content') return byId.get(node.id)
      if (!['TH', 'TD', 'P', 'Span', 'Div'].includes(node.role) || !Array.isArray(node.children))
        throw Error('unknown tagged cell')
      return node.children.flatMap(gather)
    }
    for (const table of tables) {
      const rows = []
      const rowNodes = (node) => {
        if (node.role === 'TR') {
          rows.push(node)
          return
        }
        if (
          !['Table', 'THead', 'TBody', 'TFoot'].includes(node.role) ||
          !Array.isArray(node.children)
        )
          throw Error('unknown tagged row')
        for (const child of node.children) rowNodes(child)
      }
      try {
        rowNodes(table)
        const actual = rows.map((r) => {
          if (!Array.isArray(r.children) || r.children.some((c) => !['TH', 'TD'].includes(c.role)))
            throw Error('unknown tagged columns')
          return r.children.map((c) => gather(c).map(identity).sort())
        })
        for (let start = 0; start + expected.length <= actual.length; start++)
          if (same(actual.slice(start, start + expected.length), expected))
            matches.push({ table, start })
      } catch {
        continue
      }
    }
    return matches.length === 1
  } catch {
    return false
  }
}

// Repeated native lane rules enclose column labels above a complete
// coefficient/error pair. Only that leading packet is certified here: the
// lower body, footer and crop remain under their existing proofs.
export function recoverNativeRuledCoefficientHeader(table, items, captions, rules) {
  const crop = table.cropRect,
    columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .map((o) => o.rect)
      .sort((a, b) => a[0] - b[0]),
    count = columns.length,
    intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    contains = (a, b) => b[0] >= a[0] && b[1] >= a[1] && b[2] <= a[2] && b[3] <= a[3],
    nearby = items.filter((i) => intersects(i.rect, crop)),
    sizes = nearby.map((i) => i.height).sort((a, b) => a - b),
    height = sizes[Math.floor(sizes.length / 2)]
  if (count < 3 || count > 12 || !(height > 0) || !Number.isFinite(height)) return
  const local = rules.filter(
      (r) => r[0] < crop[2] && r[2] > crop[0] && r[1] >= crop[1] && r[3] <= crop[3]
    ),
    bands = [...Map.groupBy(local, (r) => r[1]).values()]
      .map((g) => [...g].sort((a, b) => a[0] - b[0]))
      .sort((a, b) => a[0][1] - b[0][1])
  if (
    local.length !== count * 4 ||
    bands.length !== 4 ||
    bands.some(
      (g) =>
        g.length !== count ||
        g.some(
          (r, c) =>
            !r.every(Number.isFinite) ||
            r[1] !== r[3] ||
            r[2] - r[0] <= height * 2 ||
            (c && (r[0] <= g[c - 1][2] || r[0] - g[c - 1][2] > height * 0.2)) ||
            Math.abs(r[0] - bands[0][c][0]) > height * 0.15 ||
            Math.abs(r[2] - bands[0][c][2]) > height * 0.02
        )
    )
  )
    return
  const left = bands[0][0][0],
    right = bands[0].at(-1)[2],
    opening = bands[0][0][1],
    divider = bands[1][0][1],
    captionsAbove = captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] < opening &&
        opening - c.rect[3] < height * 3 &&
        c.rect[0] < right &&
        c.rect[2] > left
    )
  if (captionsAbove.length !== 1) return
  const firstBand = items.filter(
      (i) =>
        i.rect[0] < right &&
        i.rect[2] > left &&
        i.rect[1] >= captionsAbove[0].rect[3] &&
        i.baseline < divider
    ),
    firstBody = items
      .filter(
        (i) =>
          i.rect[0] < right &&
          i.rect[2] > left &&
          i.baseline > divider &&
          i.baseline < bands[2][0][1]
      )
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    lines = []
  for (const i of firstBody) {
    const line = lines.at(-1)
    if (line && Math.abs(i.baseline - line[0].baseline) < height * 0.05) line.push(i)
    else lines.push([i])
  }
  if (firstBand.length !== count - 1 || lines.length < 2) return
  const upper = lines[0],
    lower = lines[1],
    packet = [...firstBand, ...upper, ...lower],
    headBox = box(firstBand),
    scope = [left, Math.min(opening, headBox[1]), right, box(lower)[3]],
    touching = items.filter((i) => intersects(i.rect, scope)),
    cuts = [left, ...bands[0].slice(1).map((r, c) => (bands[0][c][2] + r[0]) / 2), right]
  // The opening stroke can meet a header's em edge (including native float32
  // rounding). Keep the entire observed advance and recheck the enlarged
  // packet; this neither tolerates a foreign token nor changes crop geometry.
  if (
    headBox[3] <= opening ||
    headBox[3] >= divider ||
    headBox[1] < opening - height ||
    headBox[3] >= box(upper)[1] ||
    box(upper)[3] >= box(lower)[1] ||
    upper.length !== count ||
    lower.length !== count - 1 ||
    !hasUniqueRecordTokens(touching, [firstBand, upper, lower]) ||
    packet.some(
      (i) =>
        !contains(scope, i.rect) ||
        !contains(crop, i.rect) ||
        !i.horizontal ||
        !i.rect.every(Number.isFinite) ||
        !Number.isFinite(i.baseline) ||
        !Number.isFinite(i.height) ||
        Math.abs(i.height - height) > height * 0.02 ||
        i.baseline < i.rect[1] ||
        i.baseline > i.rect[3] ||
        !i.sourceItem ||
        !Number.isInteger(i.sourceItem.pageNumber) ||
        i.sourceItem.pageNumber < 1 ||
        !Number.isInteger(i.sourceItem.index) ||
        i.sourceItem.index < 0 ||
        i.sourceItem.text !== i.text ||
        i.sourceSegment
    ) ||
    new Set(packet.map((i) => i.sourceItem.pageNumber)).size !== 1 ||
    new Set(packet.map((i) => i.sourceItem.index)).size !== packet.length
  )
    return
  const fields = (g) => {
    const result = Array(count).fill(null)
    for (const i of g) {
      const c = cuts.slice(1).findIndex((x, n) => i.rect[0] >= cuts[n] && i.rect[2] <= x)
      if (c < 0 || result[c]) return
      result[c] = i
    }
    return result
  }
  const heads = fields(firstBand),
    values = fields(upper),
    errors = fields(lower)
  if (
    !heads ||
    !values ||
    !errors ||
    heads[0] ||
    errors[0] ||
    !values[0] ||
    !/\p{L}/u.test(values[0].text) ||
    heads
      .slice(1)
      .some(
        (i, c) =>
          !i ||
          !/^\(\d+\)$/.test(i.text) ||
          Math.abs(i.baseline - firstBand[0].baseline) > height * 0.05 ||
          i.rect[0] < crop[0] + columns[c + 1][0] ||
          i.rect[2] > crop[0] + columns[c + 1][2]
      ) ||
    values
      .slice(1)
      .some(
        (i, c) =>
          !i ||
          !errors[c + 1] ||
          !/^[−–+-]?\d+\.\d+\*{0,3}$/.test(i.text) ||
          !/^\(\d+\.\d+\)$/.test(errors[c + 1].text) ||
          Math.abs(i.rect[0] + i.rect[2] - errors[c + 1].rect[0] - errors[c + 1].rect[2]) > height
      )
  )
    return
  return { rect: [crop[0], headBox[1], crop[2], headBox[3]], items: firstBand }
}

const box = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]

// A closed, two-level native header and five complete decimal lanes witness
// these uniformly spaced records. Full-em raised stars belong only to their
// unique adjacent numeric advance, never to a model row or section above it.
export function recoverNativeCoefficientRecordGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    columns = table.structure.objects
      .filter((o) => o.label === 'table column')
      .map((o) => o.rect)
      .sort((a, b) => a[0] - b[0])
  if (columns.length !== 6) return
  const nearby = tableSourceItems(items, crop),
    sizes = nearby
      .filter((i) => /^\d+\.\d+$/.test(i.text))
      .map((i) => i.height)
      .sort((a, b) => a - b),
    height = sizes[Math.floor(sizes.length / 2)]
  if (!(height > 0)) return
  const horizontal = rules.filter(
      (r) => r[1] === r[3] && r[1] > crop[1] - height && r[1] < crop[3] + height
    ),
    joined = [...Map.groupBy(horizontal, (r) => r[1]).values()]
      .map((g) => [...g].sort((a, b) => a[0] - b[0]))
      .filter((g) => g.every((r, n) => !n || Math.abs(g[n - 1][2] - r[0]) < height * 0.01))
      .map((g) => [g[0][0], g[0][1], g.at(-1)[2], g[0][1]])
      .sort((a, b) => a[1] - b[1]),
    full = joined.filter(
      (r) => Math.abs(r[0] - crop[0]) < height && Math.abs(r[2] - crop[2]) < height
    )
  if (full.length !== 3) return
  const [opening, divider, closing] = full
  if (
    divider[1] - opening[1] < height * 3 ||
    divider[1] - opening[1] > height * 5 ||
    Math.abs(closing[1] - crop[3]) > height ||
    full.some((r) => Math.abs(r[0] - opening[0]) > 0.02 || Math.abs(r[2] - opening[2]) > 0.02) ||
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < height * 2 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    ).length !== 1
  )
    return
  const cuts = [
      crop[0],
      ...columns.slice(1).map((c, n) => crop[0] + (columns[n][2] + c[0]) / 2),
      crop[2]
    ],
    parentRules = joined.filter(
      (r) =>
        r[1] > opening[1] &&
        r[1] < divider[1] &&
        r[0] > cuts[1] &&
        r[0] > cuts[2] - height * 2 &&
        r[0] < cuts[3] &&
        Math.abs(r[2] - opening[2]) < 0.02
    )
  if (parentRules.length !== 1 || joined.length !== 4) return
  const parentRule = parentRules[0],
    source = nearby.filter((i) => i.rect[1] >= opening[1] && i.rect[3] <= closing[1]),
    header = source.filter((i) => i.rect[3] < divider[1]),
    body = source.filter((i) => i.rect[1] > divider[1])
  if (
    !source.length ||
    !hasUniqueRecordTokens(source, [header, body]) ||
    nearby.some((i) => i.rect[1] < closing[1] && i.rect[3] > opening[1] && !source.includes(i))
  )
    return
  const leftHeader = header.filter((i) => i.rect[2] <= cuts[2]),
    parent = header.filter((i) => i.rect[0] >= cuts[2] && i.rect[3] < parentRule[1]),
    leaves = header.filter((i) => i.rect[0] >= cuts[2] && i.rect[1] > parentRule[1])
  if (
    !hasUniqueRecordTokens(header, [leftHeader, parent, leaves]) ||
    !readSourceRow(leftHeader, cuts, { multiline: true })
      ?.slice(0, 2)
      .every((v) => /\p{L}/u.test(v)) ||
    !parent.length ||
    !/\p{L}/u.test(parent.map((i) => i.text).join('')) ||
    !readSourceRow(leaves, cuts)
      ?.slice(2)
      .every((v) => /\p{L}/u.test(v)) ||
    leaves.some((i) => Math.abs(i.baseline - leaves[0].baseline) > height * 0.1)
  )
    return
  const stars = body.filter((i) => /^\*{1,3}$/.test(i.text)),
    main = body.filter((i) => !stars.includes(i)),
    physical = [],
    scriptAnchors = new Map()
  for (const i of main) {
    const last = physical.at(-1)
    if (last && Math.abs(i.baseline - last[0].baseline) < height * 0.1) last.push(i)
    else physical.push([i])
  }
  for (const star of stars) {
    const anchors = main.filter(
      (anchor) =>
        number.test(anchor.text) &&
        anchor.rect[0] > cuts[1] &&
        star.height >= height * 0.8 &&
        star.height <= height * 1.1 &&
        anchor.baseline - star.baseline > height * 0.35 &&
        anchor.baseline - star.baseline < height * 0.5 &&
        Math.abs(star.rect[0] - anchor.rect[2]) < height * 0.1 &&
        readSourceRow([anchor, star], cuts)
    )
    if (anchors.length !== 1) return
    const owner = physical.find((row) => row.includes(anchors[0]))
    owner.push(star)
    scriptAnchors.set(star, anchors[0])
  }
  if (!hasUniqueRecordTokens(body, physical)) return
  const values = physical.map((row) => readSourceRow(row, cuts)),
    measured = physical.filter((_, n) =>
      values[n]?.slice(1).every((v) => /^[−–-]?\d+\.\d+\*{0,3}$/.test(v))
    ),
    sections = physical.filter((_, n) => values[n]?.slice(1).every((v) => !v))
  if (
    measured.length < 6 ||
    sections.length < 2 ||
    measured.length + sections.length !== physical.length ||
    values.some((v) => !v || !/\p{L}/u.test(v[0])) ||
    main.some((i) => Math.abs(i.height - height) > height * 0.05)
  )
    return
  const labelLeft = (row) =>
      Math.min(...row.filter((i) => i.rect[2] <= cuts[1]).map((i) => i.rect[0])),
    flush = labelLeft(sections[0]),
    indent = labelLeft(measured[0]) - flush,
    gaps = physical.slice(1).map((row, n) => row[0].baseline - physical[n][0].baseline),
    leading = gaps[0]
  if (
    Math.abs(flush - opening[0]) > height * 0.1 ||
    indent < height * 0.8 ||
    indent > height * 1.2 ||
    measured.some((row) => Math.abs(labelLeft(row) - flush - indent) > height * 0.05) ||
    sections.some((row) => Math.abs(labelLeft(row) - flush) > height * 0.05) ||
    leading < height * 1.1 ||
    leading > height * 1.5 ||
    gaps.some((gap) => Math.abs(gap - leading) > height * 0.05)
  )
    return
  const edges = [crop[1], parentRule[1], divider[1]],
    records = [[...leftHeader, ...parent], leaves, ...physical]
  for (let n = 1; n < physical.length; n++) {
    const priorBottom = box(physical[n - 1])[3],
      nextTop = box(physical[n])[1]
    if (priorBottom >= nextTop) {
      // A raised star's em can cross the previous baseline, while the numeric
      // baseline is still unique. Use the midpoint between numeric baselines.
      if (!physical[n].some((i) => stars.includes(i))) return
    }
    edges.push((physical[n - 1][0].baseline + physical[n][0].baseline) / 2 - height * 0.5)
  }
  edges.push(crop[3])
  if (
    edges.length !== records.length + 1 ||
    edges.some((y, n) => n && y <= edges[n - 1]) ||
    !hasUniqueRecordTokens(source, records)
  )
    return
  return {
    cropRect: crop,
    rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
    spans: [
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 1, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 2, rowSpan: 1, colSpan: 4 },
      ...sections.map((row) => ({
        row: physical.indexOf(row) + 2,
        column: 0,
        rowSpan: 1,
        colSpan: 6
      }))
    ],
    headerRows: [0, 1],
    completeSpans: true,
    ownedTokens: new Set(source),
    scriptAnchors,
    repair: 'native-body-records-recovered'
  }
}
