/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import {
  nativeFramedRecordPacket,
  nativeFramedRecordClosure
} from './literature-pdf-native-cited-prose-records.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const same = (a, b) => a?.length === b?.length && a.every((v, n) => Math.abs(v - b[n]) < 0.02)
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 0.02 : v <= a[n] + 0.02))
const cx = (i) => (i.rect[0] + i.rect[2]) / 2
const metric = /^[+−-]?\d+(?:\.\d+)?%?$/u
const compact = (s) => s.normalize('NFD').replace(/\s/gu, '')
const declaredRect = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === 4 &&
  b.length === 4 &&
  a.every((x, n) => Number.isFinite(x) && Math.abs(x - b[n]) < 1e-6)

// Opaque printed fields, not quantitative scopes: several complete numeric
// lanes accompany one lane containing both short categories and integer pairs.
// This separate shape never supplies missing values or interprets their units.
function hasClosedMixedLiteralFields(fields, count) {
  if (count < 5 || count > 8) return false
  const numeric = /^[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[A-Za-z]{1,3})?$/u,
    integer = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)',
    pair = new RegExp(`^${integer}\\s*\\/\\s*${integer}$`, 'u'),
    category = /^\p{L}[\p{L}\p{M}-]{0,23}$/u,
    categories = new Set()
  let pairs = 0
  for (const row of fields) {
    if (row.slice(2, -1).some((column) => column.length !== 1 || !numeric.test(column[0].text)))
      return false
    const last = row.at(-1)
    if (last.length !== 1) return false
    if (category.test(last[0].text)) categories.add(last[0].text)
    else if (pair.test(last[0].text)) pairs++
    else return false
  }
  return categories.size >= 2 && pairs > 0
}

function hasDataShape(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false
  const ds = Object.getOwnPropertyDescriptors(value)
  return (
    Reflect.ownKeys(ds).length === names.length &&
    names.every((name) => ds[name]?.enumerable && Object.hasOwn(ds[name], 'value'))
  )
}

// The printed-header repair already carries this fixed whole-font witness.
// Keep it only on untouched headers; it is not a second owner or a donor token.
function isCanonicalHeaderToken(token) {
  const names = ['text', 'sourceItem', 'inlineSymbol', 'baseline', 'height', 'rect', 'horizontal'],
    rectangle = (value) => {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
      const ds = Object.getOwnPropertyDescriptors(value)
      return (
        ds.length.value === 4 &&
        Reflect.ownKeys(ds).length === 5 &&
        ['0', '1', '2', '3'].every(
          (key) =>
            ds[key]?.enumerable && Object.hasOwn(ds[key], 'value') && Number.isFinite(ds[key].value)
        )
      )
    },
    fields = (value) =>
      hasDataShape(value.sourceItem, ['pageNumber', 'index', 'text']) &&
      value.inlineSymbol === false &&
      value.horizontal === true &&
      typeof value.text === 'string' &&
      Number.isFinite(value.baseline) &&
      Number.isFinite(value.height) &&
      value.height > 0 &&
      rectangle(value.rect),
    base = (value) => hasDataShape(value, names) && fields(value)
  if (base(token)) return true
  if (!hasDataShape(token, [...names, 'sourceToken']) || !base(token.sourceToken)) return false
  return fields(token)
}

function sourceFreeCellMetadata(cell) {
  const metadata = {},
    sourceKeys = new Set([
      'sourceItem',
      'sourceItems',
      'sourceSegment',
      'sourceSegments',
      'sourceToken',
      'sourceTokens'
    ]),
    active = new Set()
  const assembly = new Set([
    'row',
    'column',
    'rowSpan',
    'colSpan',
    'text',
    'rect',
    'sourceItems',
    'sourceRects',
    'sourceTokens'
  ])
  const closedArray = (value) => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
    const ds = Object.getOwnPropertyDescriptors(value),
      length = ds.length.value
    return (
      Reflect.ownKeys(ds).length === length + 1 &&
      Array.from({ length }, (_, n) => ds[String(n)]).every(
        (d) => d?.enumerable && Object.hasOwn(d, 'value')
      )
    )
  }
  let visited = 0
  const walk = (value, depth = 0) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (!value || typeof value !== 'object' || active.has(value) || depth > 16 || ++visited > 65536)
      return false
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value),
      ds = Object.getOwnPropertyDescriptors(value)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      return false
    if (array && !closedArray(value)) return false
    if (Object.hasOwn(ds, 'pageNumber') && Object.hasOwn(ds, 'index')) return false
    active.add(value)
    for (const key of Reflect.ownKeys(ds)) {
      const d = ds[key]
      if (
        typeof key !== 'string' ||
        sourceKeys.has(key) ||
        !Object.hasOwn(d, 'value') ||
        (!d.enumerable && !(array && key === 'length')) ||
        !walk(d.value, depth + 1)
      )
        return false
    }
    active.delete(value)
    return true
  }
  const descriptors = Object.getOwnPropertyDescriptors(cell)
  if (Object.getPrototypeOf(cell) !== Object.prototype && Object.getPrototypeOf(cell) !== null)
    return
  for (const name of Reflect.ownKeys(descriptors)) {
    const d = descriptors[name]
    if (typeof name !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) return
    if (name === 'sourceItems') {
      if (
        d.value !== undefined &&
        (!closedArray(d.value) ||
          !d.value.every((origin) => {
            const ds = origin && Object.getOwnPropertyDescriptors(origin)
            return (
              ds &&
              Object.getPrototypeOf(origin) === Object.prototype &&
              Reflect.ownKeys(ds).length === 3 &&
              ['pageNumber', 'index', 'text'].every(
                (key) => ds[key]?.enumerable && Object.hasOwn(ds[key], 'value')
              )
            )
          }))
      )
        return
    } else if (name === 'sourceTokens') {
      if (
        !closedArray(d.value) ||
        !d.value.every(
          (token) =>
            (hasDataShape(token, ['text', 'rect', 'baseline', 'height']) && walk(token)) ||
            (descriptors.row.value === 0 && isCanonicalHeaderToken(token))
        )
      )
        return
    } else if (sourceKeys.has(name) || !walk(d.value)) return
    if (!assembly.has(name)) metadata[name] = d.value
  }
  return metadata
}

// Retry only after the caller has established its existing closed crop. The
// same complete native plan may then join already-owned multiline stub fonts;
// it cannot create a body record, claim an unassigned font or change pixels.
function reconcileNativeCompleteFencedStubOwners(result, inventory, captions, rules, context) {
  try {
    const cells = result?.cells,
      grid = result?.grid,
      count = grid?.[0]?.length
    if (
      !Array.isArray(cells) ||
      !Array.isArray(grid) ||
      result.parts ||
      result.unassigned?.length ||
      !cells.some((c) => c.row > 0 && c.column === 0 && !c.text?.trim() && c.rowSpan === 1)
    )
      return
    const plan = recoverNativeFencedCohortGrid(result, inventory, captions, rules, context)
    if (
      !plan ||
      !declaredRect(plan.cropRect, result.cropRect) ||
      plan.rows.length !== grid.length ||
      plan.columns.length !== count ||
      plan.headerRows.length !== 1 ||
      plan.headerRows[0] !== 0 ||
      plan.spans.some((s) => s.column !== 0 || s.row < 1 || s.colSpan !== 1)
    )
      return
    const originals = new Map([...plan.ownedTokens].map((t) => [t.sourceItem.index, t])),
      claimed = new Set(),
      slots = new Set(),
      metadata = new Map()
    for (const cell of cells) {
      const md = sourceFreeCellMetadata(cell)
      if (
        !md ||
        cell.textRuns ||
        !Number.isInteger(cell.row) ||
        !Number.isInteger(cell.column) ||
        !Number.isInteger(cell.rowSpan) ||
        !Number.isInteger(cell.colSpan) ||
        cell.row < 0 ||
        cell.column < 0 ||
        cell.rowSpan < 1 ||
        cell.colSpan !== 1 ||
        cell.row + cell.rowSpan > grid.length ||
        cell.column >= count ||
        !valid(cell.rect) ||
        grid[cell.row][cell.column] !== cell.text ||
        !Array.isArray(cell.sourceRects) ||
        !Array.isArray(cell.sourceTokens) ||
        (cell.sourceItems?.length ?? 0) !== cell.sourceRects.length ||
        cell.sourceTokens.length !== cell.sourceRects.length
      )
        return
      metadata.set(cell, md)
      for (let row = cell.row; row < cell.row + cell.rowSpan; row++) {
        const key = `${row}:${cell.column}`
        if (slots.has(key)) return
        slots.add(key)
      }
      for (const [n, origin] of (cell.sourceItems ?? []).entries()) {
        const font = originals.get(origin.index),
          token = cell.sourceTokens[n]
        if (
          !font ||
          claimed.has(origin.index) ||
          JSON.stringify(origin) !== JSON.stringify(font.sourceItem) ||
          !declaredRect(cell.sourceRects[n], font.rect) ||
          !token ||
          !(
            hasDataShape(token, ['text', 'rect', 'baseline', 'height']) ||
            (cell.row === 0 && isCanonicalHeaderToken(token))
          ) ||
          token.text !== font.text ||
          !declaredRect(token.rect, font.rect) ||
          token.baseline !== font.baseline ||
          token.height !== font.height
        )
          return
        if (cell.row === 0 && isCanonicalHeaderToken(token)) {
          for (const witness of [token, token.sourceToken].filter(Boolean))
            if (
              JSON.stringify(witness.sourceItem) !== JSON.stringify(origin) ||
              witness.text !== font.text ||
              !declaredRect(witness.rect, font.rect) ||
              witness.baseline !== font.baseline ||
              witness.height !== font.height
            )
              return
        }
        claimed.add(origin.index)
      }
      if (compact((cell.sourceItems ?? []).map((o) => o.text).join('')) !== compact(cell.text))
        return
    }
    if (claimed.size !== originals.size || slots.size !== grid.length * count) return
    const packet = nativeFramedRecordPacket(
      context,
      [...plan.ownedTokens],
      context.sourcePage.pageNumber
    )
    if (!packet) return
    const ink = new Map(packet.selected.map((r) => [r.index, r.ink.map((x) => x * packet.scale)])),
      changes = new Map(),
      removed = new Set(),
      nextGrid = grid.map((row) => [...row])
    for (const span of plan.spans) {
      const end = span.row + span.rowSpan,
        donors = cells
          .filter((c) => c.column === 0 && c.row >= span.row && c.row < end)
          .sort((a, b) => a.row - b.row),
        frame = [
          plan.columns[0][0],
          plan.rows[span.row][1],
          plan.columns[0][2],
          plan.rows[end - 1][3]
        ],
        fonts = [...plan.ownedTokens]
          .filter((t) => inside(frame, t.rect))
          .sort((a, b) => a.sourceItem.index - b.sourceItem.index),
        origins = donors
          .flatMap((c) =>
            (c.sourceItems ?? []).map((origin, n) => ({
              origin,
              rect: c.sourceRects[n],
              token: c.sourceTokens[n]
            }))
          )
          .sort((a, b) => a.origin.index - b.origin.index)
      if (
        !donors.length ||
        !fonts.length ||
        donors.some((c) => c.row + c.rowSpan > end) ||
        JSON.stringify(origins.map((o) => o.origin.index)) !==
          JSON.stringify(fonts.map((t) => t.sourceItem.index))
      )
        return
      if (donors.length === 1 && donors[0].row === span.row && donors[0].rowSpan === span.rowSpan)
        continue
      if (
        donors.length !== span.rowSpan ||
        donors.some(
          (c, n) =>
            c.row !== span.row + n ||
            c.rowSpan !== 1 ||
            c.rect[0] !== donors[0].rect[0] ||
            c.rect[2] !== donors[0].rect[2] ||
            JSON.stringify(metadata.get(c)) !== JSON.stringify(metadata.get(donors[0]))
        )
      )
        return
      const rect = [
        donors[0].rect[0],
        Math.min(...donors.map((c) => c.rect[1])),
        donors[0].rect[2],
        Math.max(...donors.map((c) => c.rect[3]))
      ]
      if (
        !inside(result.cropRect, rect) ||
        fonts.some((t) => !inside(rect, t.rect) || !inside(rect, ink.get(t.sourceItem.index)))
      )
        return
      for (const other of cells.filter((c) => !donors.includes(c))) {
        const overlap = [
          Math.max(rect[0], other.rect[0]),
          Math.max(rect[1], other.rect[1]),
          Math.min(rect[2], other.rect[2]),
          Math.min(rect[3], other.rect[3])
        ]
        if (valid(overlap) && !donors.some((c) => inside(c.rect, overlap))) return
      }
      const merged = {
        ...donors[0],
        row: span.row,
        rowSpan: span.rowSpan,
        text: fonts.map((t) => t.text).join(' '),
        rect,
        sourceItems: origins.map((o) => o.origin),
        sourceRects: origins.map((o) => o.rect),
        sourceTokens: origins.map((o) => o.token)
      }
      changes.set(donors[0], merged)
      donors.slice(1).forEach((c) => removed.add(c))
      for (let row = span.row; row < end; row++)
        nextGrid[row][0] = row === span.row ? merged.text : ''
    }
    if (!changes.size) return
    return {
      ...result,
      grid: nextGrid,
      cells: cells.filter((c) => !removed.has(c)).map((c) => changes.get(c) ?? c)
    }
  } catch {
    return
  }
}

// This grammar has two independent sources of boundaries: complete native
// horizontal fences delimit nonnumeric cohorts, and printed underlines form
// an exhaustive header tree over complete scalar leaf records. Text centering
// and the detector's rows never determine a cohort's scope.
export function recoverNativeFencedCohortGrid(table, inventory, captions, rules, context) {
  try {
    const crop = table?.cropRect,
      page = context?.sourcePage,
      native = context?.nativeGlyphContext,
      sourceContent = context?.sourceContent,
      v = context?.viewport,
      scale = v?.scale
    if (
      !valid(crop) ||
      table.readingRotation ||
      !Array.isArray(inventory) ||
      !Array.isArray(rules) ||
      !Array.isArray(captions) ||
      !page ||
      !native ||
      context.content !== sourceContent ||
      scale !== 1.5 ||
      v.rotation ||
      native.viewport?.scale !== 1 ||
      native.viewport.rotation ||
      page.rotation ||
      page.pageNumber !== native.pageNumber ||
      Math.abs(v.width - page.width * scale) > 0.02 ||
      Math.abs(v.height - page.height * scale) > 0.02
    )
      return
    const near = inventory.filter((i) => i.text?.trim() && valid(i.rect) && hit(i.rect, crop)),
      heights = near.map((i) => i.height).sort((a, b) => a - b),
      em = heights[Math.floor(heights.length / 2)]
    if (!(em > 0)) return
    const paint = new Map(),
      nativeRules = collectTableRules(context.operators, v, paint)
    const full = nativeRules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[1] >= crop[1] - em &&
          r[1] <= crop[3] + em &&
          Math.abs(r[0] - crop[0]) < em &&
          Math.abs(r[2] - crop[2]) < em
      )
      .sort((a, b) => a[1] - b[1])
    if (
      full.length < 4 ||
      full.length > 10 ||
      full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
    )
      return
    const opening = full[0],
      divider = full[1],
      closing = full.at(-1),
      frame = [opening[0], opening[1], opening[2], closing[1]]
    if (divider[1] - opening[1] < em || divider[1] - opening[1] > em * 7) return
    const source = inventory.filter((i) => i.text?.trim() && valid(i.rect) && hit(i.rect, frame))
    if (
      !source.length ||
      source.length > 4096 ||
      source.some(
        (i) =>
          !inside(frame, i.rect) ||
          !i.horizontal ||
          Math.abs(i.height - em) > 0.02 ||
          !Number.isFinite(i.baseline)
      ) ||
      near.some((i) => !source.includes(i)) ||
      !proveNativeUniqueWholeFonts(source, inventory)
    )
      return
    const originals = sourceContent.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, v, 0))
      .filter((i) => hit(i.rect, frame))
    if (
      originals.length !== source.length ||
      originals.some(
        (i) =>
          source.filter(
            (s) =>
              s.sourceItem?.pageNumber === page.pageNumber &&
              s.sourceItem.index === i.sourceItem?.index &&
              s.text === i.text &&
              same(s.rect, i.rect)
          ).length !== 1
      )
    )
      return
    const header = source.filter((i) => i.rect[3] < divider[1]),
      body = source.filter((i) => i.rect[1] > divider[1])
    if (!header.length || header.length + body.length !== source.length) return
    const domains = []
    for (const i of [...body].sort((a, b) => a.rect[0] - b.rect[0])) {
      const prior = domains.at(-1)
      if (prior && i.rect[0] <= prior[1] + 0.02) prior[1] = Math.max(prior[1], i.rect[2])
      else domains.push([i.rect[0], i.rect[2]])
    }
    const count = domains.length
    if (count < 4 || count > 20) return
    const initialCuts = [
        frame[0],
        ...domains.slice(1).map((r, n) => (domains[n][1] + r[0]) / 2),
        frame[2]
      ],
      lane = (i) =>
        initialCuts
          .slice(1)
          .findIndex(
            (x, c) =>
              i.rect[0] >= initialCuts[c] - (c === 0 ? 0.02 : 0) &&
              i.rect[2] <= x + (c === count - 1 ? 0.02 : 0)
          )
    if (body.some((i) => lane(i) < 0)) return
    const records = []
    for (const i of body
      .filter((i) => lane(i) > 0)
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const prior = records.at(-1)
      if (prior && Math.abs(prior[0].baseline - i.baseline) < 0.02) prior.push(i)
      else records.push([i])
    }
    if (records.length < 4 || records.length > 255) return
    const fields = []
    let scalar = true
    for (const row of records) {
      if (row.length !== count - 1) return
      const columns = [[], ...Array.from({ length: count - 1 }, () => [])]
      for (let c = 1; c < count; c++) {
        const matches = row.filter((i) => lane(i) === c)
        if (matches.length !== 1 || (c === 1 && !/\p{L}/u.test(matches[0].text))) return
        columns[c] = matches
        if (c > 1 && !metric.test(matches[0].text)) scalar = false
      }
      fields.push(columns)
    }
    if (!scalar && !hasClosedMixedLiteralFields(fields, count)) return
    const recordBounds = records.map((r) => [
      Math.min(...r.map((i) => i.rect[1])),
      Math.max(...r.map((i) => i.rect[3]))
    ])
    if (recordBounds.some((r, n) => n && r[0] <= recordBounds[n - 1][1])) return
    const partial = nativeRules.filter(
      (r) =>
        r[0] <= frame[2] &&
        r[2] >= frame[0] &&
        r[1] >= frame[1] &&
        r[3] <= frame[3] &&
        !full.includes(r)
    )
    if (partial.some((r) => r[1] !== r[3] || r[1] <= opening[1] || r[1] >= divider[1])) return
    const levels = [...new Set(partial.map((r) => r[1]))].sort((a, b) => a - b),
      headerCount = levels.length + 1
    if (
      headerCount > 3 ||
      (!scalar && headerCount !== 1) ||
      (records.length + headerCount) * count > 2048
    )
      return
    const centers = domains.map((r) => (r[0] + r[1]) / 2),
      nodes = [],
      parents = new Set()
    for (let level = 0; level < levels.length; level++) {
      const group = partial.filter((r) => r[1] === levels[level]).sort((a, b) => a[0] - b[0]),
        covered = []
      for (const rule of group) {
        const columns = centers
          .map((x, n) => (x > rule[0] && x < rule[2] ? n : -1))
          .filter((n) => n >= 0)
        if (
          !columns.length ||
          columns[0] < 2 ||
          columns.some((c, n) => n && c !== columns[n - 1] + 1)
        )
          return
        const candidates = header.filter(
          (i) =>
            i.rect[0] >= rule[0] &&
            i.rect[2] <= rule[2] &&
            i.rect[3] < rule[1] &&
            i.rect[1] > (level ? levels[level - 1] : opening[1])
        )
        if (
          candidates.length !== 1 ||
          parents.has(candidates[0]) ||
          !/\p{L}|%/u.test(candidates[0].text)
        )
          return
        if (
          level &&
          nodes.filter(
            (n) =>
              n.level === level - 1 &&
              n.columns[0] <= columns[0] &&
              n.columns.at(-1) >= columns.at(-1)
          ).length !== 1
        )
          return
        parents.add(candidates[0])
        nodes.push({ level, columns, font: candidates[0] })
        covered.push(...columns)
      }
      if (covered.length !== count - 2 || covered.some((c, n) => c !== n + 2)) return
    }
    const leaves = Array.from({ length: count }, () => [])
    for (const i of header.filter((i) => !parents.has(i))) {
      const matches = initialCuts
        .slice(1)
        .map((x, c) => (cx(i) > initialCuts[c] && cx(i) < x ? c : -1))
        .filter((c) => c >= 0)
      if (matches.length !== 1) return
      leaves[matches[0]].push(i)
    }
    if (
      leaves[0].length > 1 ||
      leaves[0].some((i) => !/\p{L}/u.test(i.text)) ||
      leaves.slice(1).some((g) => g.length !== 1 || !/\p{L}/u.test(g[0].text)) ||
      leaves.slice(2).some((g) => g[0].rect[1] <= (levels.at(-1) ?? opening[1]))
    )
      return
    const expanded = domains.map((r, c) => [
      Math.min(r[0], ...leaves[c].map((i) => i.rect[0])),
      Math.max(r[1], ...leaves[c].map((i) => i.rect[2]))
    ])
    if (expanded.some((r, n) => n && r[0] <= expanded[n - 1][1])) return
    const cuts = [
        frame[0],
        ...expanded.slice(1).map((r, n) => (expanded[n][1] + r[0]) / 2),
        frame[2]
      ],
      spans = []
    if (headerCount > 1) {
      spans.push(
        { row: 0, column: 0, rowSpan: headerCount, colSpan: 1 },
        { row: 0, column: 1, rowSpan: headerCount, colSpan: 1 }
      )
      for (const node of nodes)
        spans.push({
          row: node.level,
          column: node.columns[0],
          rowSpan: 1,
          colSpan: node.columns.length
        })
    }
    const rowBounds = [frame[1], ...levels, divider[1]],
      ownedRecords = new Set(),
      ownedStubs = new Set()
    for (let b = 1; b < full.length - 1; b++) {
      const top = full[b][1],
        bottom = full[b + 1][1],
        indices = records
          .map((r, n) => (recordBounds[n][0] > top && recordBounds[n][1] < bottom ? n : -1))
          .filter((n) => n >= 0),
        stubs = body
          .filter((i) => lane(i) === 0 && i.rect[1] > top && i.rect[3] < bottom)
          .sort((a, b) => a.baseline - b.baseline)
      if (
        indices.length < 2 ||
        indices.length > 12 ||
        indices.some((n, k) => ownedRecords.has(n) || (k && n !== indices[k - 1] + 1)) ||
        !stubs.length ||
        stubs.length > 3 ||
        stubs.some(
          (s, n) =>
            !/\p{L}/u.test(s.text) ||
            /\p{N}/u.test(s.text) ||
            (n &&
              (s.baseline - stubs[n - 1].baseline < em * 0.7 ||
                s.baseline - stubs[n - 1].baseline > em * 1.5))
        )
      )
        return
      for (const i of stubs) ownedStubs.add(i)
      spans.push({ row: headerCount + indices[0], column: 0, rowSpan: indices.length, colSpan: 1 })
      for (const n of indices) {
        ownedRecords.add(n)
        rowBounds.push(
          n === indices.at(-1) ? bottom : (recordBounds[n][1] + recordBounds[n + 1][0]) / 2
        )
      }
    }
    if (
      ownedRecords.size !== records.length ||
      ownedStubs.size !== body.filter((i) => lane(i) === 0).length ||
      rowBounds.length !== records.length + headerCount + 1 ||
      rowBounds.some((y, n) => n && y <= rowBounds[n - 1])
    )
      return
    const bound = matchNativeFigureRenderContext(
      native,
      page.pageNumber,
      sourceContent,
      native.viewport,
      page.graphicsBounds,
      native.sourceSha256
    )
    if (!bound) return
    const c = { ...bound, pageNumber: page.pageNumber, sourceSha256: native.sourceSha256 },
      tokens = c.content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, c.viewport, 0)),
      ordered = source.slice().sort((a, b) => a.sourceItem.index - b.sourceItem.index),
      packet = nativeWholeCellInkPacket(page, tokens, c, {
        text: ordered.map((i) => i.text).join(''),
        sourceItems: ordered.map((i) => i.sourceItem),
        sourceRects: ordered.map((i) => i.rect.map((x) => x / scale))
      })
    if (!packet) return
    const claimed = new Set()
    for (const i of ordered) {
      const matches = packet.records.filter((r) => r.index === i.sourceItem.index)
      if (matches.length !== 1) return
      const r = matches[0]
      if (
        !r.advanceComplete ||
        r.r.str !== i.text ||
        !same(tableTextToken(r.r, v, 0).rect, i.rect) ||
        r.part.some(
          ({ g }) =>
            !valid(g.ink) ||
            !valid(g.advance) ||
            g.rendererSkipped ||
            g.textPaint?.fillAlpha !== 1 ||
            g.textPaint.fillColor?.toLowerCase() === '#ffffff' ||
            !inside(
              frame,
              g.ink.map((x) => x * scale)
            )
        )
      )
        return
      for (const g of new Set(r.part.map((z) => z.g))) {
        if (claimed.has(g)) return
        claimed.add(g)
      }
    }
    const expected = [...full, ...partial],
      intersects = (r) =>
        r[0] <= frame[2] && r[2] >= frame[0] && r[1] <= frame[3] && r[3] >= frame[1],
      local = nativeRules.filter(intersects)
    if (
      local.length !== expected.length ||
      expected.some(
        (r) =>
          local.filter((n) => same(n, r) && paint.has(n.join(','))).length !== 1 ||
          rules.filter((n) => same(n, r)).length !== 1
      ) ||
      rules.some((r) => intersects(r) && !expected.some((e) => same(e, r)))
    )
      return
    const painted = expected.map((r) => paint.get(r.join(','))),
      cropRect = crop.map((x, n) =>
        n < 2 ? Math.min(x, ...painted.map((r) => r[n])) : Math.max(x, ...painted.map((r) => r[n]))
      )
    if (
      !valid(cropRect) ||
      packet.glyphs.some(
        (g) =>
          !claimed.has(g) &&
          valid(g.ink) &&
          hit(
            g.ink.map((x) => x * scale),
            cropRect
          )
      )
    )
      return
    const title = captions.filter(
      (cap) =>
        cap.page === page.pageNumber &&
        captionKind(cap.lines?.[0]) === 'table' &&
        valid(cap.rect) &&
        cap.rect[0] < frame[2] &&
        cap.rect[2] > frame[0] &&
        ((cap.rect[3] < frame[1] && frame[1] - cap.rect[3] < em * 2) ||
          (cap.rect[1] > frame[3] && cap.rect[1] - frame[3] < em * 2))
    )
    if (title.length !== 1) return
    const titleFonts = packet.records.filter(
      (r) =>
        valid(r.rect) &&
        hit(
          r.rect.map((x) => x * scale),
          title[0].rect
        )
    )
    if (
      !titleFonts.length ||
      titleFonts.some(
        (r) =>
          !r.advanceComplete ||
          !inside(
            title[0].rect,
            r.rect.map((x) => x * scale)
          )
      ) ||
      compact(titleFonts.map((r) => r.r.str).join('')) !== compact(title[0].lines.join(''))
    )
      return
    const colors = new Map(),
      fills = new Map(),
      stack = []
    let stroke = '#000000',
      fill = '#000000'
    for (let id = 0; id < c.operators.fnArray.length; id++) {
      const op = c.operators.fnArray[id],
        a = c.operators.argsArray[id]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push([stroke, fill])
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!stack.length) return
        ;[stroke, fill] = stack.pop()
      } else if (op === OPS.setStrokeRGBColor) stroke = a[0]
      else if (op === OPS.setFillRGBColor) fill = a[0]
      else if (op === OPS.constructPath) {
        colors.set(id, stroke)
        fills.set(id, fill)
      }
    }
    if (stack.length) return
    const seen = new Set(),
      backgrounds = new Set()
    for (const [id, path] of packet.evidence.paths) {
      const a = c.operators.argsArray[id]
      if (
        !a?.[2] ||
        a[2].length !== 4 ||
        !Array.from(a[2]).every(Number.isFinite) ||
        !path.transform
      )
        return
      const matrix = Util.transform(v.transform, path.transform),
        pad = (path.lineWidth * Math.max(1, packet.strokeMargins.get(id) ?? 10)) / 2,
        bounds = packet.box(
          Array.from(a[2], (x, n) => x + (n < 2 ? -pad : pad)),
          matrix
        )
      if (!valid(bounds)) return
      if (!hit(bounds, cropRect)) continue
      const p = a[1]?.[0]
      if (a[0] === OPS.fill) {
        // A light cell background may decorate an already proven field. It
        // supplies no row, column or cohort boundary, and must precede every
        // glyph it underpaints. Curves, unions and partial-cell masks decline.
        const raw = packet.box(Array.from(a[2]), matrix),
          color = fills.get(id),
          rgb = /^#([0-9a-f]{2})\1\1$/iu.exec(color ?? ''),
          tone = rgb ? parseInt(rgb[1], 16) : 0
        if (
          p?.length !== 13 ||
          p[0] !== 0 ||
          p[3] !== 1 ||
          p[6] !== 1 ||
          p[9] !== 1 ||
          p[12] !== 4 ||
          p[1] !== p[10] ||
          p[2] !== p[5] ||
          p[4] !== p[7] ||
          p[8] !== p[11] ||
          matrix[1] !== 0 ||
          matrix[2] !== 0 ||
          path.fillAlpha !== 1 ||
          tone < 204 ||
          tone > 254 ||
          !valid(raw) ||
          !valid(path.clip) ||
          !inside(
            path.clip,
            raw.map((x) => x / scale)
          )
        )
          return
        const owners = []
        for (let n = 0; n < records.length; n++)
          for (const token of records[n]) {
            const col = lane(token),
              cell = [
                col ? cuts[col] : cropRect[0],
                rowBounds[headerCount + n],
                col === count - 1 ? cropRect[2] : cuts[col + 1],
                rowBounds[headerCount + n + 1]
              ]
            const record = packet.records.find((r) => r.index === token.sourceItem.index),
              gs = record?.part.map((z) => z.g)
            if (
              inside(cell, raw) &&
              gs?.length &&
              gs.every(
                (g) =>
                  id < g.packet.start &&
                  inside(
                    raw,
                    g.ink.map((x) => x * scale)
                  )
              ) &&
              ![...claimed].some(
                (g) =>
                  !gs.includes(g) &&
                  hit(
                    g.ink.map((x) => x * scale),
                    raw
                  )
              )
            )
              owners.push(token)
          }
        if (owners.length !== 1 || backgrounds.has(owners[0])) return
        backgrounds.add(owners[0])
        continue
      }
      if (
        a[0] !== OPS.stroke ||
        p?.length !== 6 ||
        p[0] !== 0 ||
        p[3] !== 1 ||
        matrix[1] !== 0 ||
        matrix[2] !== 0 ||
        !path.solidStroke ||
        path.strokeAlpha !== 1 ||
        path.lineCap !== 0 ||
        !(path.lineWidth > 0) ||
        !/^#[0-9a-f]{6}$/iu.test(colors.get(id) ?? '') ||
        colors.get(id).toLowerCase() === '#ffffff'
      )
        return
      const xy = [Array.from(p.slice(1, 3)), Array.from(p.slice(4, 6))]
      for (const point of xy) Util.applyTransform(point, matrix)
      const line = [
          Math.min(...xy.map((p) => p[0])),
          Math.min(...xy.map((p) => p[1])),
          Math.max(...xy.map((p) => p[0])),
          Math.max(...xy.map((p) => p[1]))
        ],
        edge = expected.findIndex((f) => same(f, line))
      if (
        edge < 0 ||
        seen.has(edge) ||
        !valid(path.clip) ||
        !inside(
          path.clip,
          bounds.map((x) => x / scale)
        )
      )
        return
      seen.add(edge)
    }
    if (
      seen.size !== expected.length ||
      packet.evidence.images.some(
        (i) =>
          !valid(i.rect) ||
          hit(
            i.rect.map((x) => x * scale),
            cropRect
          )
      )
    )
      return
    cuts[0] = cropRect[0]
    cuts[cuts.length - 1] = cropRect[2]
    rowBounds[0] = cropRect[1]
    rowBounds[rowBounds.length - 1] = cropRect[3]
    return {
      cropRect,
      rows: rowBounds.slice(1).map((y, n) => [cuts[0], rowBounds[n], cuts.at(-1), y]),
      columns: cuts.slice(1).map((x, n) => [cuts[n], cropRect[1], x, cropRect[3]]),
      spans,
      headerRows: Array.from({ length: headerCount }, (_, n) => n),
      completeSpans: true,
      preservePhysicalRows: true,
      ownedTokens: new Set(source),
      repair: 'native-body-records-recovered'
    }
  } catch {
    return
  }
}

function closedDeclaredArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  const ds = Object.getOwnPropertyDescriptors(value),
    length = ds.length.value
  return (
    Reflect.ownKeys(ds).length === length + 1 &&
    Array.from({ length }, (_, n) => ds[String(n)]).every(
      (d) => d?.enumerable && Object.hasOwn(d, 'value')
    )
  )
}

function declaredMetadataWithoutFontReferences(value, refs, ancestors = new Set()) {
  if (!value || typeof value !== 'object') return true
  if (refs.has(value) || ancestors.has(value)) return false
  const ds = Object.getOwnPropertyDescriptors(value)
  if (ds.text && ds.rect && (ds.baseline || ds.height)) return false
  const next = new Set(ancestors)
  next.add(value)
  return Object.values(ds).every(
    (d) => Object.hasOwn(d, 'value') && declaredMetadataWithoutFontReferences(d.value, refs, next)
  )
}

// A complete existing grid already supplies every field. Native leaf glyph
// bands and full painted fences may repair only the declared textual stub's
// ownership; they do not rebuild math/header cells or create Source claims.
function reconcileNativeDeclaredFencedStubOwners(result, inventory, captions, rules, context) {
  try {
    const ds = result && Object.getOwnPropertyDescriptors(result)
    if (
      !ds ||
      Object.getPrototypeOf(result) !== Object.prototype ||
      Reflect.ownKeys(ds).some(
        (key) => typeof key !== 'string' || !ds[key].enumerable || !Object.hasOwn(ds[key], 'value')
      )
    )
      return
    const cells = result.cells,
      grid = result.grid,
      page = context?.sourcePage?.pageNumber,
      scale = context?.viewport?.scale
    if (
      !closedDeclaredArray(cells) ||
      !closedDeclaredArray(grid) ||
      !grid.every(closedDeclaredArray)
    )
      return
    const count = grid[0]?.length
    if (
      !closedDeclaredArray(inventory) ||
      grid.length < 5 ||
      grid.length > 255 ||
      count < 4 ||
      count > 20 ||
      grid.length * count > 2048 ||
      grid.some((row) => row.length !== count || row.some((text) => typeof text !== 'string')) ||
      result.parts ||
      result.cropRects ||
      result.unassigned?.length ||
      result.clipped?.length ||
      result.readingRotation ||
      !valid(result.cropRect) ||
      scale !== 1.5 ||
      !Number.isSafeInteger(page) ||
      context.content !== context.sourceContent ||
      context.viewport.rotation ||
      context.nativeGlyphContext?.viewport?.rotation
    )
      return
    const sourceKeys = [
      'sourceItem',
      'sourceItems',
      'sourceSegment',
      'sourceSegments',
      'sourceToken',
      'sourceTokens'
    ]
    if (sourceKeys.some((key) => Object.hasOwn(ds, key))) return
    // populateTableCellText keeps its original whole fonts on this immutable,
    // non-enumerable carrier even when every string has an owner. Validate that
    // fixed protocol explicitly; JSON serialization would hide its evidence.
    const unassigned = result.unassigned,
      unassignedDescriptors = unassigned && Object.getOwnPropertyDescriptors(unassigned),
      reconciliation = unassignedDescriptors?.reconciliationItems
    if (
      !Array.isArray(unassigned) ||
      Object.getPrototypeOf(unassigned) !== Array.prototype ||
      unassigned.length !== 0 ||
      Reflect.ownKeys(unassignedDescriptors).some(
        (key) => key !== 'length' && key !== 'reconciliationItems'
      ) ||
      (reconciliation &&
        (!Object.hasOwn(reconciliation, 'value') ||
          reconciliation.enumerable ||
          reconciliation.writable ||
          reconciliation.configurable ||
          !closedDeclaredArray(reconciliation.value)))
    )
      return
    const rootMetadata = Object.fromEntries(
      Object.entries(result).filter(
        ([key, value]) =>
          key !== 'cells' &&
          key !== 'unassigned' &&
          !(key === 'captionIssue' && value === undefined)
      )
    )
    if (!sourceFreeCellMetadata(rootMetadata)) return
    const originalFonts = new Map()
    for (const font of inventory) {
      const origin = font?.sourceItem
      if (
        !origin ||
        origin.pageNumber !== page ||
        !Number.isSafeInteger(origin.index) ||
        originalFonts.has(origin.index)
      )
        return
      originalFonts.set(origin.index, font)
    }
    const claimed = new Set(),
      slots = new Map(),
      metadata = new Map(),
      sourceRefs = new Set(),
      tokenRefs = new Set(),
      fontsByCell = new Map()
    sourceRefs.add(unassigned)
    if (reconciliation) sourceRefs.add(reconciliation.value)
    for (const cell of cells) {
      const md = sourceFreeCellMetadata(cell)
      if (
        !md ||
        !Number.isInteger(cell.row) ||
        !Number.isInteger(cell.column) ||
        !Number.isInteger(cell.rowSpan) ||
        cell.rowSpan < 1 ||
        cell.colSpan !== 1 ||
        cell.row < 0 ||
        cell.row + cell.rowSpan > grid.length ||
        cell.column < 0 ||
        cell.column >= count ||
        (cell.column > 0 && cell.rowSpan !== 1) ||
        (cell.row === 0 && cell.rowSpan !== 1) ||
        !valid(cell.rect) ||
        grid[cell.row][cell.column] !== cell.text ||
        !closedDeclaredArray(cell.sourceRects) ||
        !closedDeclaredArray(cell.sourceTokens) ||
        (cell.sourceItems !== undefined && !closedDeclaredArray(cell.sourceItems)) ||
        (cell.sourceItems?.length ?? 0) !== cell.sourceRects.length ||
        cell.sourceTokens.length !== cell.sourceRects.length
      )
        return
      if (
        cell.textRuns !== undefined &&
        (!closedDeclaredArray(cell.textRuns) ||
          !cell.textRuns.every(
            (run) =>
              hasDataShape(run, ['text', 'position']) &&
              typeof run.text === 'string' &&
              ['normal', 'subscript', 'superscript'].includes(run.position)
          ) ||
          compact(cell.textRuns.map((run) => run.text).join('')) !== compact(cell.text))
      )
        return
      metadata.set(cell, md)
      const fonts = []
      for (const [n, origin] of (cell.sourceItems ?? []).entries()) {
        const font = originalFonts.get(origin.index),
          token = cell.sourceTokens[n]
        if (
          !font ||
          claimed.has(origin.index) ||
          tokenRefs.has(token) ||
          JSON.stringify(origin) !== JSON.stringify(font.sourceItem) ||
          !declaredRect(cell.sourceRects[n], font.rect) ||
          !(
            hasDataShape(token, ['text', 'rect', 'baseline', 'height']) ||
            (cell.row === 0 && isCanonicalHeaderToken(token))
          ) ||
          token.text !== font.text ||
          !declaredRect(token.rect, font.rect) ||
          token.baseline !== font.baseline ||
          token.height !== font.height
        )
          return
        if (cell.row === 0 && isCanonicalHeaderToken(token))
          for (const witness of [token, token.sourceToken].filter(Boolean)) {
            if (
              JSON.stringify(witness.sourceItem) !== JSON.stringify(origin) ||
              witness.text !== font.text ||
              !declaredRect(witness.rect, font.rect) ||
              witness.baseline !== font.baseline ||
              witness.height !== font.height
            )
              return
            sourceRefs.add(witness)
            sourceRefs.add(witness.sourceItem)
            sourceRefs.add(witness.rect)
          }
        claimed.add(origin.index)
        tokenRefs.add(token)
        sourceRefs.add(origin)
        sourceRefs.add(cell.sourceRects[n])
        sourceRefs.add(token)
        sourceRefs.add(token.rect)
        fonts.push(font)
      }
      if (compact(fonts.map((font) => font.text).join('')) !== compact(cell.text)) return
      fontsByCell.set(cell, fonts)
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
        const key = `${r}:${cell.column}`
        if (slots.has(key) || (r !== cell.row && grid[r][cell.column] !== '')) return
        slots.set(key, cell)
      }
    }
    if (reconciliation) {
      const reconciled = new Set(),
        names = ['text', 'sourceItem', 'inlineSymbol', 'baseline', 'height', 'rect', 'horizontal']
      for (const token of reconciliation.value) {
        if (!hasDataShape(token, names) || !isCanonicalHeaderToken(token)) return
        const origin = token.sourceItem,
          font = originalFonts.get(origin.index)
        if (
          !font ||
          !claimed.has(origin.index) ||
          reconciled.has(origin.index) ||
          JSON.stringify(origin) !== JSON.stringify(font.sourceItem) ||
          token.text !== font.text ||
          !declaredRect(token.rect, font.rect) ||
          token.baseline !== font.baseline ||
          token.height !== font.height
        )
          return
        reconciled.add(origin.index)
        sourceRefs.add(token)
        sourceRefs.add(origin)
        sourceRefs.add(token.rect)
      }
      if (reconciled.size !== claimed.size) return
    }
    if (
      slots.size !== grid.length * count ||
      !declaredMetadataWithoutFontReferences(rootMetadata, sourceRefs) ||
      [...metadata.values()].some((md) => !declaredMetadataWithoutFontReferences(md, sourceRefs))
    )
      return
    const source = [...claimed].map((index) => originalFonts.get(index))
    if (!proveNativeUniqueWholeFonts(source, inventory)) return
    const packet = nativeFramedRecordPacket(context, source, page)
    if (!packet) return
    const ink = new Map(
        packet.selected.map((record) => [record.index, record.ink.map((value) => value * scale)])
      ),
      bound = (fonts) => {
        const parts = fonts.map((font) => ink.get(font.sourceItem.index))
        return parts.length && parts.every(valid)
          ? [
              Math.min(...parts.map((r) => r[0])),
              Math.min(...parts.map((r) => r[1])),
              Math.max(...parts.map((r) => r[2])),
              Math.max(...parts.map((r) => r[3]))
            ]
          : undefined
      },
      h = source.map((font) => font.height).sort((a, b) => a - b)[Math.floor(source.length / 2)],
      nativeRules = collectTableRules(context.operators, context.viewport),
      full = nativeRules
        .filter(
          (rule) =>
            rule[1] === rule[3] &&
            rule[1] >= result.cropRect[1] - h &&
            rule[1] <= result.cropRect[3] + h &&
            Math.abs(rule[0] - result.cropRect[0]) < h &&
            Math.abs(rule[2] - result.cropRect[2]) < h
        )
        .sort((a, b) => a[1] - b[1])
    if (
      full.length < 4 ||
      full.length > grid.length + 2 ||
      full.some(
        (rule) => Math.abs(rule[0] - full[0][0]) > 0.02 || Math.abs(rule[2] - full[0][2]) > 0.02
      ) ||
      !nativeFramedRecordClosure(packet, full)
    )
      return
    const headerBottom = full[1][1],
      bodyBottom = full.at(-1)[1],
      anchors = [],
      parents = cells.filter((cell) => cell.column === 0 && cell.row > 0 && cell.text.trim())
    if (
      parents.length < 2 ||
      new Set(parents.map((cell) => compact(cell.text))).size !== parents.length ||
      parents.some((cell) => !/^\p{L}[\p{L}\p{M}\p{N} ._()+–—-]{0,127}$/u.test(cell.text))
    )
      return
    for (let r = 0; r < grid.length; r++)
      for (let c = 0; c < count; c++) {
        const cell = slots.get(`${r}:${c}`),
          fonts = fontsByCell.get(cell)
        if (r === 0 || c > 0) {
          if (cell.row !== r || !fonts.length || !cell.text.trim()) return
          const b = bound(fonts)
          if (!b || (r === 0 ? b[3] >= headerBottom : b[1] <= headerBottom || b[3] >= bodyBottom))
            return
          if (r > 0 && c === 1) anchors.push({ row: r, cell, bound: b })
        } else if (!cell.text.trim() && (cell.rowSpan !== 1 || fonts.length)) return
      }
    if (anchors.some((anchor, n) => n && anchor.bound[1] <= anchors[n - 1].bound[3])) return
    for (let n = 0; n < anchors.length; n++) {
      const anchor = anchors[n],
        top = n ? (anchors[n - 1].bound[3] + anchor.bound[1]) / 2 : headerBottom,
        bottom =
          n === anchors.length - 1 ? bodyBottom : (anchor.bound[3] + anchors[n + 1].bound[1]) / 2
      for (let c = 1; c < count; c++) {
        const b = bound(fontsByCell.get(slots.get(`${anchor.row}:${c}`)))
        if (!b || b[1] <= top || b[3] >= bottom) return
      }
    }
    const parentBounds = new Map(parents.map((cell) => [cell, bound(fontsByCell.get(cell))])),
      stubRight = Math.max(
        ...parents.flatMap((cell) =>
          fontsByCell
            .get(cell)
            .map((font) => Math.max(font.rect[2], ink.get(font.sourceItem.index)[2]))
        )
      ),
      leafLeft = Math.min(
        ...anchors.flatMap((anchor) =>
          fontsByCell
            .get(anchor.cell)
            .map((font) => Math.min(font.rect[0], ink.get(font.sourceItem.index)[0]))
        )
      )
    if (!(stubRight < leafLeft)) return
    const scopes = [],
      usedParents = new Set(),
      usedRows = new Set()
    for (let n = 1; n < full.length - 1; n++) {
      const top = full[n][1],
        bottom = full[n + 1][1],
        rows = anchors.filter((anchor) => anchor.bound[1] > top && anchor.bound[3] < bottom),
        owners = parents.filter((cell) => {
          const b = parentBounds.get(cell)
          return b && b[1] > top && b[3] < bottom
        })
      if (!rows.length) {
        const strip = [full[0][0] / scale, top / scale, full[0][2] / scale, bottom / scale]
        if (owners.length || packet.proof.glyphs.some((g) => valid(g.ink) && hit(g.ink, strip)))
          return
        continue
      }
      if (
        rows.length < 2 ||
        owners.length !== 1 ||
        usedParents.has(owners[0]) ||
        rows.some((row, k) => usedRows.has(row.row) || (k && row.row !== rows[k - 1].row + 1))
      )
        return
      for (const row of rows) {
        for (let c = 1; c < count; c++) {
          const b = bound(fontsByCell.get(slots.get(`${row.row}:${c}`)))
          if (b[1] <= top || b[3] >= bottom) return
        }
        usedRows.add(row.row)
      }
      usedParents.add(owners[0])
      scopes.push({ cell: owners[0], row: rows[0].row, rowSpan: rows.length })
    }
    if (usedRows.size !== grid.length - 1 || usedParents.size !== parents.length) return
    const blanks = cells.filter((cell) => cell.column === 0 && cell.row > 0 && !cell.text.trim())
    for (const blank of blanks) {
      const owner = scopes.find(
        (scope) => blank.row >= scope.row && blank.row < scope.row + scope.rowSpan
      )?.cell
      if (!owner || JSON.stringify(metadata.get(blank)) !== JSON.stringify(metadata.get(owner)))
        return
    }
    const changes = new Map()
    for (const scope of scopes)
      if (scope.cell.row !== scope.row || scope.cell.rowSpan !== scope.rowSpan)
        changes.set(scope.cell, { ...scope.cell, row: scope.row, rowSpan: scope.rowSpan })
    if (!changes.size) return
    const nextGrid = grid.map((row, n) => (n ? [...row] : row))
    for (let r = 1; r < nextGrid.length; r++) nextGrid[r][0] = ''
    for (const scope of scopes) nextGrid[scope.row][0] = scope.cell.text
    return {
      ...result,
      grid: nextGrid,
      cells: cells.filter((cell) => !blanks.includes(cell)).map((cell) => changes.get(cell) ?? cell)
    }
  } catch {
    return
  }
}

// Prefer the complete existing reconstruction; the independent fallback only
// changes an already-declared textual stub's topology in a fully owned grid.
export function reconcileNativeClosedFencedStubOwners(result, inventory, captions, rules, context) {
  const ds = result && Object.getOwnPropertyDescriptors(result)
  if (
    !ds ||
    Reflect.ownKeys(ds).some(
      (key) => typeof key !== 'string' || !ds[key].enumerable || !Object.hasOwn(ds[key], 'value')
    ) ||
    !closedDeclaredArray(ds.grid?.value) ||
    !ds.grid.value.every(closedDeclaredArray) ||
    !closedDeclaredArray(ds.cells?.value) ||
    ds.cells.value.some(
      (cell) =>
        !cell ||
        Reflect.ownKeys(Object.getOwnPropertyDescriptors(cell)).some((key) => {
          const d = Object.getOwnPropertyDescriptor(cell, key)
          return typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')
        })
    )
  )
    return
  return (
    reconcileNativeCompleteFencedStubOwners(result, inventory, captions, rules, context) ??
    reconcileNativeDeclaredFencedStubOwners(result, inventory, captions, rules, context)
  )
}
