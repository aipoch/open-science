/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import {
  nativeFramedRecordPacket,
  nativeFramedRecordClosure
} from './literature-pdf-native-cited-prose-records.mjs'
const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  near = (a, b) => Math.abs(a - b) < 0.02,
  same = (a, b) => a.length === b.length && a.every((x, n) => near(x, b[n])),
  over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

const sourceKeys = new Set([
  'sourceItem',
  'sourceItems',
  'sourceSegment',
  'sourceSegments',
  'sourceToken',
  'sourceTokens'
])
const shape = (v, keys) => {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype) return false
  const ds = Object.getOwnPropertyDescriptors(v)
  return (
    Reflect.ownKeys(ds).length === keys.length &&
    keys.every((k) => ds[k]?.enumerable && Object.hasOwn(ds[k], 'value'))
  )
}
const closedArray = (v) => {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return false
  const ds = Object.getOwnPropertyDescriptors(v),
    n = ds.length.value
  return (
    n <= 65536 &&
    Reflect.ownKeys(ds).length === n + 1 &&
    Array.from({ length: n }, (_, i) => ds[i]?.enumerable && Object.hasOwn(ds[i], 'value')).every(
      Boolean
    )
  )
}
function sourceFree(v, active = new Set(), depth = 0, counter = { n: 0 }) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (!v || typeof v !== 'object' || depth > 16 || ++counter.n > 65536 || active.has(v))
    return false
  const array = Array.isArray(v),
    ds = Object.getOwnPropertyDescriptors(v)
  if (array ? !closedArray(v) : Object.getPrototypeOf(v) !== Object.prototype) return false
  if (Object.hasOwn(ds, 'pageNumber') && Object.hasOwn(ds, 'index')) return false
  if (ds.text && ds.rect && (ds.baseline || ds.height)) return false
  active.add(v)
  for (const k of Reflect.ownKeys(ds)) {
    const d = ds[k]
    if (
      typeof k !== 'string' ||
      sourceKeys.has(k) ||
      !Object.hasOwn(d, 'value') ||
      (!d.enumerable && !(array && k === 'length')) ||
      !sourceFree(d.value, active, depth + 1, counter)
    )
      return false
  }
  active.delete(v)
  return true
}
function rawSeed(table) {
  const keys = new Set([
    'id',
    'page',
    'detection',
    'readingRotation',
    'cropRect',
    'structure',
    'rowCount',
    'columnCount',
    'spans',
    'grid',
    'unassigned',
    'sourceViewport'
  ])
  return (
    table &&
    Object.getPrototypeOf(table) === Object.prototype &&
    Reflect.ownKeys(table).every((k) => keys.has(k)) &&
    sourceFree(table)
  )
}
function originalToken(t) {
  if (
    !shape(t, ['text', 'sourceItem', 'inlineSymbol', 'baseline', 'height', 'rect', 'horizontal']) ||
    !shape(t.sourceItem, ['pageNumber', 'index', 'text']) ||
    !closedArray(t.rect) ||
    !valid(t.rect)
  )
    return false
  return (
    t.inlineSymbol === false &&
    t.horizontal === true &&
    typeof t.text === 'string' &&
    t.sourceItem.text === t.text &&
    Number.isSafeInteger(t.sourceItem.index) &&
    Number.isSafeInteger(t.sourceItem.pageNumber) &&
    Number.isFinite(t.baseline) &&
    Number.isFinite(t.height) &&
    t.height > 0
  )
}

// A separate four-rule grammar; the existing three-rule parser is unchanged.
export function recoverNativeFourRuleRecordGrid(table, items, captions, rules, context) {
  try {
    if (
      !rawSeed(table) ||
      !closedArray(items) ||
      items.length > 4096 ||
      !items.every(originalToken) ||
      !closedArray(captions) ||
      !sourceFree(captions)
    )
      return
    const crop = table?.cropRect,
      page = context?.sourcePage?.pageNumber,
      v = context?.viewport
    if (
      !valid(crop) ||
      table.readingRotation ||
      v?.scale !== 1.5 ||
      v.rotation ||
      context.content !== context.sourceContent ||
      !Number.isInteger(page) ||
      !Array.isArray(items)
    )
      return
    const native = joinHorizontalTableRules(collectTableRules(context.operators, v)),
      full = native
        .filter(
          (r) =>
            r[1] === r[3] &&
            r[0] >= crop[0] - 0.02 &&
            r[2] <= crop[2] + 0.02 &&
            r[1] >= crop[1] &&
            r[1] <= crop[3]
        )
        .sort((a, b) => a[1] - b[1])
    if (full.length !== 4 || full.some((r) => !near(r[0], full[0][0]) || !near(r[2], full[0][2])))
      return
    const [opening, divider, terminal, closing] = full,
      belongs = (t) =>
        t.text?.trim() &&
        valid(t.rect) &&
        t.rect[0] >= opening[0] - 0.02 &&
        t.rect[2] <= opening[2] + 0.02 &&
        t.baseline > opening[1] &&
        t.baseline < closing[1],
      source = items.filter(belongs).sort((a, b) => a.sourceItem?.index - b.sourceItem?.index),
      hs = source.map((t) => t.height).sort((a, b) => a - b),
      h = hs[hs.length >> 1]
    if (
      !source.length ||
      source.length > 1024 ||
      source.some(
        (t) =>
          t.horizontal !== true ||
          t.sourceSegments?.length ||
          t.sourceSegment ||
          t.sourceToken ||
          t.sourceItem?.pageNumber !== page ||
          t.sourceItem.text !== t.text ||
          Math.abs(t.height - h) > h * 0.02
      ) ||
      !proveNativeUniqueWholeFonts(source, items)
    )
      return
    const originals = context.sourceContent.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, v, 0))
      .filter(belongs)
    if (
      originals.length !== source.length ||
      originals.some(
        (t) =>
          source.filter(
            (s) =>
              s.sourceItem.index === t.sourceItem.index &&
              s.text === t.text &&
              same(s.rect, t.rect) &&
              near(s.baseline, t.baseline) &&
              near(s.height, t.height)
          ).length !== 1
      )
    )
      return
    const domains = []
    for (const t of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
      const p = domains.at(-1)
      if (p && t.rect[0] - p[1] < h * 0.3) p[1] = Math.max(p[1], t.rect[2])
      else domains.push([t.rect[0], t.rect[2]])
    }
    const n = domains.length
    if (n !== 5 && n !== 6) return
    const lane = (t) =>
        domains.findIndex((d) => t.rect[0] >= d[0] - 0.02 && t.rect[2] <= d[1] + 0.02),
      header = source.filter((t) => t.baseline < divider[1]),
      tail = source.filter((t) => t.baseline > terminal[1]),
      body = source.filter((t) => t.baseline > divider[1] && (n === 5 || t.baseline < terminal[1])),
      fields = (group) => domains.map((_, c) => group.filter((t) => lane(t) === c)),
      ordered = (group) => group.every((t, k) => !k || lane(t) >= lane(group[k - 1])),
      lines = (field) =>
        field.every(
          (t, k) =>
            !k ||
            (near(t.baseline, field[k - 1].baseline)
              ? t.rect[0] >= field[k - 1].rect[2] - 0.02
              : t.baseline - field[k - 1].baseline >= h &&
                t.baseline - field[k - 1].baseline <= h * 1.3)
        )
    if (
      !header.length ||
      !ordered(header) ||
      fields(header).some(
        (f) => !f.length || !lines(f) || !near(f[0].baseline, header[0].baseline)
      ) ||
      source.some((t) => lane(t) < 0) ||
      header.some((t) => t.rect[1] < opening[1] || t.rect[3] > divider[1])
    )
      return
    const groups = []
    for (const t of body) {
      const p = groups.at(-1)?.at(-1)
      if (!p || (lane(p) === n - 1 && lane(t) === 0)) groups.push([])
      else if (lane(t) < lane(p)) return
      groups.at(-1).push(t)
    }
    if (
      groups.length < 3 ||
      groups.length > 64 ||
      groups.some((g) =>
        fields(g).some((f) => !f.length || !lines(f) || !near(f[0].baseline, g[0].baseline))
      )
    )
      return
    let mode,
      footer = false
    if (n === 5) {
      const last = groups.at(-1),
        lastFields = fields(last),
        primary = lastFields[0][0].baseline,
        words = (fonts) =>
          fonts
            .map((t) => t.text)
            .join(' ')
            .match(/\p{L}[\p{L}\p{M}]*/gu) ?? [],
        prose = (fonts) =>
          fonts.every((t) => /^[\p{L}\p{M}\p{P}\s]+$/u.test(t.text)) &&
          words(fonts).length >= 3 &&
          words(fonts.filter((t) => near(t.baseline, primary))).length >= 2
      if (
        tail.length !== last.length ||
        tail.some((t) => !last.includes(t)) ||
        lastFields.slice(0, 2).some((f) => f.some((t) => !near(t.baseline, primary))) ||
        lastFields.slice(2).some((f) => new Set(f.map((t) => t.baseline)).size !== 2) ||
        lastFields.slice(2).some((f) => !prose(f)) ||
        groups.slice(0, -1).some((g) => g.some((t) => t.baseline >= terminal[1]))
      )
        return
      mode = 'terminal-wrapped'
    } else {
      const f = fields(tail)
      if (
        tail.length !== 3 ||
        f[0].length !== 1 ||
        f[4].length !== 1 ||
        f[5].length !== 1 ||
        f.slice(1, 4).some((q) => q.length) ||
        !/^\p{L}[\p{L}\p{M} .-]{0,39}$/u.test(f[0][0].text) ||
        !f.slice(4).every((q) => /^\d+$/u.test(q[0].text)) ||
        !tail.every((t) => near(t.baseline, tail[0].baseline)) ||
        groups.some((g) =>
          fields(g)
            .slice(4)
            .some((q) => q.length !== 1 || !/^\d+$/u.test(q[0].text))
        )
      )
        return
      mode = 'count-footer'
      footer = true
    }
    const packet = nativeFramedRecordPacket(context, source, page)
    if (!packet || !nativeFramedRecordClosure(packet, full)) return
    const titles = captions.filter(
      (c) =>
        c.page === page &&
        captionKind(c.lines?.[0]) === 'table' &&
        valid(c.rect) &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < h * 2
    )
    if (titles.length !== 1) return
    const title = titles[0],
      titleFonts = packet.proof.records.filter(
        (r) =>
          valid(r.rect) &&
          over(
            r.rect.map((x) => x * v.scale),
            title.rect
          )
      ),
      compact = (s) => s.normalize('NFD').replace(/\s/gu, '')
    if (
      !titleFonts.length ||
      titleFonts.some(
        (r) =>
          !r.advanceComplete ||
          r.rect.some((x, k) =>
            k < 2 ? x * v.scale < title.rect[k] - 0.02 : x * v.scale > title.rect[k] + 0.02
          )
      ) ||
      compact(titleFonts.map((r) => r.r.str).join('')) !== compact(title.lines.join(''))
    )
      return
    const ink = new Map(packet.selected.map((r) => [r.index, r.ink.map((x) => x * v.scale)])),
      bounds = (g) => {
        const b = g.map((t) => ink.get(t.sourceItem.index))
        return [
          Math.min(...b.map((r) => r[0])),
          Math.min(...b.map((r) => r[1])),
          Math.max(...b.map((r) => r[2])),
          Math.max(...b.map((r) => r[3]))
        ]
      },
      recordBounds = groups.map(bounds),
      nativeLanes = domains.map((_, c) => bounds(source.filter((t) => lane(t) === c)))
    const fontBounds = groups.map((g) => [
      Math.min(...g.map((t) => t.rect[1])),
      Math.max(...g.map((t) => t.rect[3]))
    ])
    if (
      fontBounds.some((b, k) => k && b[0] - fontBounds[k - 1][1] < h * 0.05) ||
      nativeLanes.some((b, k) => k && b[0] <= nativeLanes[k - 1][2]) ||
      recordBounds.some(
        (b, k) =>
          b[1] <= divider[1] ||
          b[3] >= (footer ? terminal[1] : closing[1]) ||
          (k && b[1] - recordBounds[k - 1][3] < h * 0.05)
      ) ||
      source.some((t) => !over(crop, ink.get(t.sourceItem.index)))
    )
      return
    const cuts = [
        opening[0],
        ...domains.slice(1).map((d, k) => (domains[k][1] + d[0]) / 2),
        opening[2]
      ],
      ys = [
        crop[1],
        divider[1],
        ...recordBounds
          .slice(1)
          .map((b, k) =>
            mode === 'terminal-wrapped' && k === recordBounds.length - 2
              ? terminal[1]
              : (recordBounds[k][3] + b[1]) / 2
          ),
        ...(footer ? [terminal[1]] : []),
        crop[3]
      ]
    return {
      cropRect: [...crop],
      rows: ys.slice(1).map((y, k) => [cuts[0], ys[k], cuts.at(-1), y]),
      columns: cuts.slice(1).map((x, k) => [cuts[k], crop[1], x, crop[3]]),
      spans: [],
      headerRows: [0],
      completeSpans: true,
      preservePhysicalRows: true,
      ownedTokens: new Set(source),
      repair: 'native-body-records-recovered'
    }
  } catch {
    return
  }
}
