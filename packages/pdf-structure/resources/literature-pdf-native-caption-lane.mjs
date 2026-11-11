/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { captureNativeTableCropWitness } from './literature-pdf-native-table-crop-witness.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  groupNativeCaptionFragments,
  groupPageLines,
  joinCaptionLines,
  sourceWordSpellings,
  captionKind
} from './literature-pdf-caption-group.mjs'
import {
  nativeClosedProgramInkPacket,
  nativeForeignCompoundInkPacket,
  nativePageTextPacketInventory
} from './literature-pdf-figure-native-plot-labels.mjs'
import {
  retainNativeRecoveryInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import {
  nativeFigurePathPaint,
  nativeCompleteFormCropPngSafe
} from './literature-pdf-figure-native-complete-form.mjs'
import {
  getPdfCropRasterProtectionFromPng,
  getInitialPdfCropRaster,
  matchesInitialPdfCropPng,
  MAX_BYTES
} from './literature-pdf-crop.mjs'
const finite = (r, n) => Array.isArray(r) && r.length === n && r.every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const overlap = (a, b) =>
  valid(a) && valid(b) && a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const compact = (s) => s.replace(/\s/gu, '')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const recoveredCaptions = new WeakMap()
const nativeIndexExclusions = new WeakMap()

// This negative classification cannot supply Source owners, cells or a crop.
// Keep the original index table and its internal association inputs intact.
export function createNativeIndexCaptionExclusion(page, captions, tokens, context) {
  try {
    const own = nativeRecoveryOwnValues(context),
      current = own && retainNativeRecoveryInputs([page, captions, tokens, context], own.viewport)
    if (
      !current ||
      !Array.isArray(captions) ||
      !Array.isArray(tokens) ||
      !Number.isSafeInteger(page.pageNumber) ||
      page.pageNumber < 1 ||
      !finite([page.width, page.height], 2) ||
      page.width <= 0 ||
      page.height <= 0 ||
      (page.renderRotation !== undefined && page.renderRotation !== 0) ||
      context.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      page.invalidGraphicsBounds !== 0 ||
      page.rotation !== 0 ||
      context.viewport.scale !== 1 ||
      context.viewport.rotation !== 0 ||
      context.viewport.width !== page.width ||
      context.viewport.height !== page.height
    )
      return
    const v = context.viewport,
      o = context.operators,
      raw = context.content?.items,
      near = (a, b) => Math.abs(a - b) < 1e-6,
      contains = (outer, r) =>
        r.every((n, i) => (i < 2 ? n >= outer[i] - 1e-6 : n <= outer[i] + 1e-6)),
      role = (s) => s.replace(/\s/gu, '').toUpperCase()
    if (
      !finite(v.transform, 6) ||
      !Array.isArray(raw) ||
      raw.length > 4096 ||
      !Array.isArray(o?.fnArray) ||
      !Array.isArray(o.argsArray) ||
      o.fnArray.length !== o.argsArray.length ||
      o.fnArray.length > 100000 ||
      !Array.isArray(context.graphicsBounds) ||
      !Array.isArray(page.graphicsBounds)
    )
      return
    const closedSource = nativePageTextPacketInventory(page, tokens, context, true)
    if (!closedSource) return
    const sources = []
    for (let index = 0; index < raw.length; index++) {
      const r = raw[index]
      if (typeof r?.str !== 'string') return
      if (!r.str.trim()) continue
      const source = nativeRecoveryOwnValues(r.sourceItem),
        style = context.content.styles?.[r.fontName]
      if (
        !source ||
        Reflect.ownKeys(r.sourceItem).length !== 3 ||
        !['index', 'pageNumber', 'text'].every(
          (k) => Object.getOwnPropertyDescriptor(r.sourceItem, k)?.enumerable
        ) ||
        Object.keys(source).sort().join(',') !== 'index,pageNumber,text' ||
        source.index !== index ||
        source.pageNumber !== page.pageNumber ||
        source.text !== r.str ||
        !finite(r.transform, 6) ||
        r.transform[0] <= 0 ||
        r.transform[0] !== r.transform[3] ||
        r.transform[1] !== 0 ||
        r.transform[2] !== 0 ||
        r.dir !== 'ltr' ||
        !Number.isFinite(r.width) ||
        r.width <= 0 ||
        r.height !== r.transform[3] ||
        style?.vertical !== false ||
        !Number.isFinite(style.ascent) ||
        !Number.isFinite(style.descent) ||
        style.ascent <= 0 ||
        style.descent > 0 ||
        style.ascent <= style.descent
      )
        return
      const expected = tableTextToken(r, v, 0),
        matches = tokens.filter(
          (t) =>
            t.sourceItem?.index === index &&
            t.sourceItem?.pageNumber === page.pageNumber &&
            t.sourceItem.text === r.str &&
            t.text === r.str
        )
      if (
        matches.length !== 1 ||
        Reflect.ownKeys(matches[0].sourceItem).length !== 3 ||
        matches[0].sourceToken != null ||
        matches[0].sourceSegment != null ||
        !valid(expected.rect) ||
        !valid(matches[0].rect) ||
        !matches[0].rect.every((n, k) => near(n, expected.rect[k])) ||
        !near(matches[0].baseline, expected.baseline) ||
        !near(matches[0].height, expected.height)
      )
        return
      sources.push({ r, index, rect: expected.rect, baseline: expected.baseline })
    }
    const rows = []
    for (const s of sources) {
      let row = rows.find((row) => near(row.baseline, s.baseline))
      if (!row) rows.push((row = { baseline: s.baseline, items: [] }))
      row.items.push(s)
    }
    rows.sort((a, b) => a.baseline - b.baseline)
    for (const row of rows) row.items.sort((a, b) => a.rect[0] - b.rect[0])
    const headers = rows.filter(
      (row) =>
        row.items.length === 3 &&
        role(row.items[0].r.str) === 'IDENTIFIER' &&
        role(row.items[1].r.str) === 'DESCRIPTION' &&
        /^(?:STUDY\/)?CONTEXT$/u.test(role(row.items[2].r.str))
    )
    if (headers.length !== 1) return
    const header = headers[0],
      previous = rows.filter((r) => r.baseline < header.baseline).at(-1),
      heading = previous && role(previous.items.map((s) => s.r.str).join('')),
      match = heading?.match(
        /^(?:\d+(?:\.\d+)*[.)]?)?INDEXOF(?:(?:SUPPLEMENTARY|ONLINEONLY|AND|&))*(FIGURES|TABLES)$/u
      )
    if (
      !match ||
      header.baseline - previous.baseline > Math.max(...previous.items.map((s) => s.r.height)) * 3
    )
      return
    const kind = match[1] === 'FIGURES' ? 'figure' : 'table',
      em = Math.max(...header.items.map((s) => s.r.height)),
      evidence = closedSource.evidence,
      paints = []
    for (const [i, state] of evidence.paths) {
      const a = o.argsArray[i],
        q = Array.from(a?.[1]?.[0] ?? []),
        b = Array.from(a?.[2] ?? [])
      if (
        ![OPS.fill, OPS.eoFill, OPS.endPath].includes(a?.[0]) ||
        a[1].length !== 1 ||
        q.length !== 13 ||
        q[0] !== 0 ||
        q[3] !== 1 ||
        q[6] !== 1 ||
        q[9] !== 1 ||
        q[12] !== 4 ||
        !q.every(Number.isFinite) ||
        !finite(b, 4) ||
        !finite(state.transform, 6) ||
        !valid(state.clip)
      )
        return
      const corners = [0, 3, 6, 9].map((n) => [q[n + 1], q[n + 2]])
      if (
        new Set(corners.map((p) => p[0])).size !== 2 ||
        new Set(corners.map((p) => p[1])).size !== 2 ||
        corners.some(
          (p, n) => p[0] !== corners[(n + 1) % 4][0] && p[1] !== corners[(n + 1) % 4][1]
        ) ||
        !b.every(
          (n, k) =>
            Math.abs(n - (k < 2 ? Math.min : Math.max)(...corners.map((p) => p[k % 2]))) < 1e-4
        )
      )
        return
      if (a[0] === OPS.endPath) continue
      const m = Util.transform(v.transform, state.transform)
      if (m[1] !== 0 || m[2] !== 0 || m[0] <= 0 || m[3] >= 0 || state.fillAlpha !== 1) return
      const ps = corners.map((p) => {
          const t = [...p]
          Util.applyTransform(t, m)
          return t
        }),
        rect = [
          Math.min(...ps.map((p) => p[0])),
          Math.min(...ps.map((p) => p[1])),
          Math.max(...ps.map((p) => p[0])),
          Math.max(...ps.map((p) => p[1]))
        ]
      if (
        !valid(rect) ||
        !contains(state.clip, rect) ||
        context.graphicsBounds.filter((g) => g.kind === 'path' && g.operationIndex === i).length !==
          1
      )
        return
      paints.push({ i, rect })
    }
    if (
      page.graphicsBounds.length !== context.graphicsBounds.length ||
      page.graphicsBounds.some(
        (g, i) =>
          g.kind !== context.graphicsBounds[i].kind ||
          g.operationIndex !== context.graphicsBounds[i].operationIndex ||
          !finite(g.normalizedRect, 4) ||
          !g.normalizedRect.every((n, k) => n === context.graphicsBounds[i].normalizedRect[k])
      )
    )
      return
    const rails = []
    for (const p of paints.filter((p) => p.rect[3] - p.rect[1] <= em * 0.2)) {
      let rail = rails.find((r) => Math.abs(r.y - (p.rect[1] + p.rect[3]) / 2) < 1e-4)
      if (!rail) rails.push((rail = { y: (p.rect[1] + p.rect[3]) / 2, parts: [] }))
      rail.parts.push(p)
    }
    const closed = rails.flatMap((rail) => {
      const parts = rail.parts.sort((a, b) => a.rect[0] - b.rect[0])
      let right = parts[0].rect[2]
      for (const p of parts.slice(1)) {
        if (p.rect[0] > right + 1e-4) return []
        right = Math.max(right, p.rect[2])
      }
      return [
        {
          ...rail,
          left: parts[0].rect[0],
          right,
          thickness: Math.max(...parts.map((p) => p.rect[3] - p.rect[1]))
        }
      ]
    })
    const tops = closed.filter(
      (r) =>
        r.y > previous.baseline &&
        r.y < header.baseline &&
        r.left < header.items[0].rect[0] &&
        r.right > header.items[2].rect[2]
    )
    if (tops.length !== 1) return
    const top = tops[0],
      frame = closed
        .filter(
          (r) =>
            r.y >= top.y &&
            Math.abs(r.left - top.left) <= Math.max(r.thickness, top.thickness) * 2 + 1e-4 &&
            Math.abs(r.right - top.right) <= Math.max(r.thickness, top.thickness) * 2 + 1e-4
        )
        .sort((a, b) => a.y - b.y)
    if (
      frame.length !== 3 ||
      frame[0] !== top ||
      frame[1].y <= header.baseline ||
      frame[1].y - header.baseline > em * 2 ||
      frame[2].y - frame[1].y < em * 4
    )
      return
    const area = [
        Math.min(...frame.map((r) => r.left)),
        top.y,
        Math.max(...frame.map((r) => r.right)),
        frame[2].y
      ],
      permitted = new Set(frame.flatMap((r) => r.parts.map((p) => p.i)))
    if (
      paints.some((p) => overlap(p.rect, area) && !permitted.has(p.i)) ||
      evidence.images.some((im) => !valid(im.rect) || overlap(im.rect, area)) ||
      context.graphicsBounds.some((g) =>
        g.kind === 'path'
          ? !paints.some((p) => p.i === g.operationIndex)
          : g.kind !== 'image' ||
            evidence.images.filter((im) => im.operationIndex === g.operationIndex).length !== 1 ||
            overlap(
              g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width)),
              area
            )
      )
    )
      return
    const body = rows.filter((row) => row.baseline > frame[1].y && row.baseline < frame[2].y)
    if (body.length < 3 || body.length > 256) return
    const anchors = header.items.map((s) => s.rect[0]),
      entries = [],
      identifiers = []
    let pending = false
    for (const row of body) {
      const cells = [[], [], []]
      for (const s of row.items) {
        const col = anchors.findLastIndex((x) => s.rect[0] >= x - 1e-6)
        if (col < 0 || s.rect[2] > (col < 2 ? anchors[col + 1] : area[2]) + 1e-6) return
        cells[col].push(s)
      }
      const label = role(cells[0].map((s) => s.r.str).join('')),
        identifier = new RegExp(
          '^(?:' +
            (kind === 'figure' ? 'FIGURE|FIG\\.' : 'TABLE|TAB\\.') +
            ')[A-Z]?\\d+(?:\\([A-Z0-9-]+\\))?$',
          'u'
        ).test(label)
      if (label === 'ONLINEONLY') {
        if (pending) return
        entries.push({ items: [], columns: new Set() })
        pending = true
      } else if (identifier) {
        if (!pending) entries.push({ items: [], columns: new Set() })
        pending = false
        identifiers.push({ items: cells[0], label })
      } else if (label || !entries.length || pending) return
      const entry = entries.at(-1)
      if (!entry) return
      cells.forEach((cell, col) => {
        for (const s of cell) entry.items.push({ ...s, col })
        if (cell.length) entry.columns.add(col)
      })
    }
    if (
      pending ||
      entries.length < 3 ||
      new Set(identifiers.map((r) => r.label)).size !== identifiers.length
    )
      return
    let last = -1
    for (const entry of entries) {
      const ordered = entry.items.sort((a, b) => a.index - b.index)
      if (
        entry.columns.size !== 3 ||
        ordered[0].index <= last ||
        ordered.some((r, i) => i > 0 && r.col < ordered[i - 1].col)
      )
        return
      last = ordered.at(-1).index
    }
    if (
      body
        .flatMap((row) => row.items)
        .some((s) => {
          const rs = closedSource.records.filter((r) => r.index === s.index)
          // The strict unscoped packet already proves every whole advance;
          // advanceComplete is only an explicit field on scoped packets.
          return rs.length !== 1 || rs[0].r !== s.r
        })
    )
      return
    const literalClosed = (c) => {
      const wanted = role(c.lines.join(' '))
      let prefix = ''
      // A geometric caption may stop after the next row's identifier prefix.
      // Every included literal must still end at a whole original native item;
      // unrelated cells inside its union rectangle do not become caption text.
      return body
        .flatMap((row) => row.items.filter((s) => contains(c.rect, s.rect)))
        .some((s) => {
          prefix += role(s.r.str)
          return prefix === wanted
        })
    }
    const excluded = captions.filter(
      (c) =>
        c.page === page.pageNumber &&
        valid(c.rect) &&
        Array.isArray(c.lines) &&
        c.lines.length > 0 &&
        c.lines.length <= 32 &&
        c.lines.every((s) => typeof s === 'string' && s.trim()) &&
        !c.regions &&
        !c.parts &&
        captionKind(c.lines[0]) === kind &&
        contains([area[0], header.baseline, area[2], area[3]], c.rect) &&
        identifiers.some(
          (id) =>
            role(c.lines.join(' ')).startsWith(id.label) &&
            id.items.every((s) => contains(c.rect, s.rect))
        ) &&
        literalClosed(c)
    )
    if (!excluded.length || !current()) return
    const data = { excludedCaptions: excluded, indexKind: kind, logicalRows: entries.length },
      outputCurrent = retainNativeRecoveryInputs([data]),
      handle = Object.freeze({})
    if (!outputCurrent) return
    nativeIndexExclusions.set(handle, {
      page,
      captions,
      tokens,
      context,
      current,
      outputCurrent,
      data
    })
    return handle
  } catch {
    return
  }
}
export function nativeIndexCaptionExclusionData(handle, page, captions, tokens, context) {
  try {
    const p = nativeIndexExclusions.get(handle)
    return p &&
      p.page === page &&
      p.captions === captions &&
      p.tokens === tokens &&
      p.context === context &&
      p.current() &&
      p.outputCurrent()
      ? p.data
      : undefined
  } catch {
    return
  }
}
// A subscript and the next row's superscript can connect two otherwise
// separate rows. Only an exact native principal-font baseline and a monotone
// source-order partition may replace that connected-component grouping.
function baselineCaptionRows(lines, tokens, context, firstNative, start, left, right) {
  const em = firstNative.height,
    principal = (t) => {
      const r = context.content.items[t.sourceItem.index]
      return r.fontName === firstNative.fontName && r.height === em
    },
    baselines = [
      ...new Set(
        tokens
          .filter(
            (t) =>
              principal(t) &&
              t.rect[0] >= left - em * 0.1 &&
              t.rect[2] <= right + em * 0.1 &&
              t.rect[1] >= start.y
          )
          .map((t) => t.baseline)
      )
    ].sort((a, b) => a - b)
  const gap = baselines.findIndex((y, i) => i > 0 && y - baselines[i - 1] > em * 1.6)
  if (gap >= 0) baselines.splice(gap)
  if (baselines.length < 2 || baselines.length > 32) return
  const groups = new Map(baselines.map((y) => [y, []]))
  for (const l of lines.filter((l) => l.y < baselines.at(-1))) {
    const parts = tokens.filter((t) => overlap(t.rect, [l.x, l.y, l.x + l.width, l.y + l.height])),
      mains = parts.filter(principal)
    let target
    if (mains.length) {
      const ys = [...new Set(mains.map((t) => t.baseline))]
      if (ys.length !== 1) return
      target = ys[0]
    } else {
      const baseline = Math.max(...parts.map((t) => t.baseline)),
        distances = baselines
          .map((y) => ({ y, d: Math.abs(y - baseline) }))
          .sort((a, b) => a.d - b.d)
      if (!distances.length || distances[0].d === distances[1]?.d || distances[0].d > em * 0.5)
        return
      target = distances[0].y
    }
    if (!groups.has(target)) return
    groups.get(target).push(l)
  }
  if ([...groups.values()].some((parts) => !parts.length)) return
  return [...groups].map(([baseline, parts]) => {
    parts.sort((a, b) => a.x - b.x || a.y - b.y)
    return {
      parts,
      nativeBaseline: baseline,
      text: parts.map((p) => p.text).join(' '),
      x: parts[0].x,
      y: Math.min(...parts.map((p) => p.y)),
      bottom: Math.max(...parts.map((p) => p.y + p.height)),
      right: Math.max(...parts.map((p) => p.x + p.width)),
      fontSize: em
    }
  })
}
function plan(page, candidate, tokens, context, anchors, others) {
  if (
    page.pageNumber !== candidate.page ||
    context.pageNumber !== candidate.page ||
    !Array.isArray(candidate.lines) ||
    candidate.lines.length < 2 ||
    candidate.lines.length > 32 ||
    /[.!?]$/u.test(candidate.lines.at(-1).trim()) ||
    !valid(candidate.rect) ||
    !['table', 'figure'].includes(captionKind(candidate.lines[0])) ||
    !Array.isArray(page.lines) ||
    !Array.isArray(anchors) ||
    !Array.isArray(others)
  )
    return
  const first = page.lines.filter((l) => l.text === candidate.lines[0])
  if (first.length !== 1) return
  const start = first[0],
    starts = tokens
      .filter(
        (t) =>
          t.text.trim() &&
          overlap(t.rect, [start.x, start.y, start.x + start.width, start.y + start.height])
      )
      .sort((a, b) => a.rect[0] - b.rect[0]),
    firstNative = starts[0] && context.content.items[starts[0].sourceItem.index]
  if (
    !firstNative ||
    !Number.isFinite(firstNative.height) ||
    !(firstNative.height > 0) ||
    !firstNative.fontName
  )
    return
  const em = firstNative.height,
    left = candidate.rect[0],
    right = candidate.rect[2],
    type = captionKind(candidate.lines[0])
  const lines = page.lines.filter(
    (l) =>
      l.y >= start.y &&
      l.x >= left - em * 0.1 &&
      l.x + l.width <= right + em * 0.1 &&
      l.fontSize >= em * 0.5 &&
      l.fontSize <= em * 1.45
  )
  const connected = groupNativeCaptionFragments(lines, em),
    bridged = connected?.some(
      (row) =>
        new Set(
          tokens
            .filter((t) => {
              const r = context.content.items[t.sourceItem.index]
              return (
                r.fontName === firstNative.fontName &&
                r.height === em &&
                overlap(t.rect, [row.x, row.y, row.right, row.bottom])
              )
            })
            .map((t) => t.baseline)
        ).size > 1
    ),
    physical = bridged
      ? baselineCaptionRows(lines, tokens, context, firstNative, start, left, right)
      : connected
  if (!physical || physical[0]?.text !== candidate.lines[0]) return
  const rows = []
  for (const row of physical) {
    if (rows.length >= 32) return
    if (rows.length && row.y - rows.at(-1).y > em * 1.6) break
    if (rows.length && captionKind(row.text)) break
    const box = [row.x, row.y, row.right, row.bottom],
      claims = tokens.filter((t) => overlap(t.rect, box)),
      principal = claims.filter((t) => {
        const r = context.content.items[t.sourceItem.index]
        return r.fontName === firstNative.fontName && r.height === em
      })
    if (!principal.length || Math.abs(row.x - left) > em * 0.1) break
    rows.push(row)
    if (
      rows.length > candidate.lines.length &&
      /[.!?]$/u.test(row.text.trim()) &&
      row.right < right - em * 1.5
    )
      break
  }
  if (
    rows.length <= candidate.lines.length ||
    !/[.!?]$/u.test(rows.at(-1).text.trim()) ||
    candidate.lines.some((s, i) => compact(s) !== compact(rows[i]?.text ?? ''))
  )
    return
  const last = rows.at(-1)
  if (
    page.lines.some(
      (l) => l.y >= last.bottom && l.y - last.y <= em * 1.6 && l.x < right && l.x + l.width > left
    )
  )
    return
  const owns = (r, t) => {
    if (!bridged) return overlap(t.rect, [r.x, r.y, r.right, r.bottom])
    if (!overlap(t.rect, [left, start.y, right, rows.at(-1).bottom])) return false
    const distances = rows
      .map((row) => ({ row, d: Math.abs(row.nativeBaseline - t.baseline) }))
      .sort((a, b) => a.d - b.d)
    return (
      distances[0]?.row === r && distances[0].d <= em * 0.5 && distances[0].d !== distances[1]?.d
    )
  }
  const selected = tokens.filter((t) => rows.some((r) => owns(r, t)))
  if (
    !selected.length ||
    selected.length > (bridged ? 4096 : 64) ||
    selected.some((t) => rows.filter((r) => owns(r, t)).length !== 1)
  )
    return
  for (const row of rows) {
    const parts = selected.filter((t) => owns(row, t)).sort((a, b) => a.rect[0] - b.rect[0])
    if (
      parts.some((t, i) => i > 0 && t.rect[0] === parts[i - 1].rect[0]) ||
      compact(parts.map((t) => t.text).join('')) !== compact(row.text)
    )
      return
  }
  if (bridged) {
    const sequence = [...selected]
      .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
      .map((t) => rows.findIndex((r) => owns(r, t)))
    if (sequence.some((n, i) => i > 0 && n < sequence[i - 1])) return
  }
  const indices = new Set(selected.map((t) => t.sourceItem.index))
  if (indices.size !== selected.length) return
  const packet =
    nativeClosedProgramInkPacket(
      page,
      tokens,
      context,
      selected.map((t) => t.sourceItem)
    ) ??
    nativeForeignCompoundInkPacket(
      page,
      tokens,
      context,
      selected.map((t) => t.sourceItem)
    ) ??
    // The existing foreign inventory retains every native literal and physical
    // glyph. This caption-only caller separately proves its complete owners;
    // the default packet's owned-accent refusal and 64-source limit stay intact.
    nativeClosedProgramInkPacket(page, tokens, context, [selected[0].sourceItem]) ??
    nativeForeignCompoundInkPacket(page, tokens, context, [])
  if (!packet) return
  const owned = packet.records.filter((r) => indices.has(r.index))
  if (
    owned.length !== indices.size ||
    owned.some(
      (r) =>
        !r.advanceComplete ||
        !valid(r.ink) ||
        r.part.some(
          (z) =>
            (z.g.compoundAccent &&
              (!/^\p{L}$/u.test(z.g.text) ||
                !Array.from(r.r.str.matchAll(/\p{L}+/gu)).some(
                  (word) => word[0].length > 1 && word[0].includes(z.g.text)
                ))) ||
            z.g.rendererSkipped ||
            z.g.textPaint?.fillAlpha !== 1 ||
            !/^#[a-f0-9]{6}$/iu.test(z.g.textPaint.fillColor) ||
            z.g.textPaint.fillColor.toLowerCase() === '#ffffff'
        )
    )
  )
    return
  const physicalOwners = new Map()
  for (const r of packet.records)
    for (const g of new Set(r.part.map((z) => z.g))) {
      const previous = physicalOwners.get(g)
      if (previous !== undefined && (indices.has(previous) || indices.has(r.index))) return
      physicalOwners.set(g, r.index)
    }
  const sourceInk = union(owned.map((r) => r.ink)),
    rect = union([...rows.map((r) => [r.x, r.y, r.right, r.bottom]), sourceInk]),
    glyphs = new Set(owned.flatMap((r) => r.part.map((z) => z.g))),
    aa = 1 / 1.5,
    protection = [rect[0] - aa, rect[1] - aa, rect[2] + aa, rect[3] + aa]
  if (
    packet.glyphs.some((g) => !glyphs.has(g) && overlap(g.ink, protection)) ||
    packet.records.some((r) => !indices.has(r.index) && overlap(r.ink, protection))
  )
    return
  const graphics = page.graphicsBounds.map((g) => ({
    ...g,
    rect: g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
  }))
  const self = others.filter(
    (c) =>
      c.page === candidate.page &&
      JSON.stringify(c.lines) === JSON.stringify(candidate.lines) &&
      JSON.stringify(c.rect) === JSON.stringify(candidate.rect)
  )
  if (
    self.length !== 1 ||
    graphics.some((g) => overlap(g.rect, protection)) ||
    others.some((c) => !self.includes(c) && valid(c.rect) && overlap(c.rect, protection))
  )
    return
  const matching = anchors.filter(
    (a) =>
      a.page === page.pageNumber &&
      a.kind === type &&
      valid(a.rect) &&
      a.caption?.lines?.[0] === candidate.lines[0] &&
      a.rect[0] < right &&
      a.rect[2] > left &&
      (type === 'table' ? a.rect[1] > protection[3] : a.rect[3] < protection[1])
  )
  if (matching.length !== 1) return
  let anchor = matching[0]
  if (type === 'table') {
    const sources = anchor.sourceItems ?? [],
      sourceIndices = new Set(sources.map((s) => s.index)),
      body = packet.records.filter((r) => sourceIndices.has(r.index))
    if (
      !body.length ||
      body.length !== sourceIndices.size ||
      body.some(
        (r) =>
          !r.advanceComplete ||
          !valid(r.ink) ||
          sources.find((s) => s.index === r.index)?.text !== r.r.str
      )
    )
      return
    const bodyInk = union(body.map((r) => r.ink)),
      rules = anchor.rules?.filter(
        (r) =>
          finite(r, 4) &&
          r[1] === r[3] &&
          r[1] > protection[3] &&
          r[1] < bodyInk[1] &&
          r[0] < bodyInk[0] &&
          r[2] > bodyInk[2]
      )
    if (rules?.length !== 1) return
    anchor = { ...anchor, captionSeparation: { rule: rules[0], bodyInk } }
  }
  if (anchor.sourceItems?.some((s) => indices.has(s.index))) return
  const principalFont = firstNative.fontName,
    fullChars = Array.from(compact(rows.map((r) => r.text).join('')))
      .sort()
      .join(''),
    nativeChars = Array.from(compact(selected.map((t) => t.text).join('')))
      .sort()
      .join('')
  if (fullChars !== nativeChars) return
  return { rows, owned, packet, indices, rect, protection, anchor, principalFont, glyphs }
}
const certificate = (p) =>
  JSON.stringify({
    rect: p.rect,
    rows: p.rows.map((r) => r.text),
    owned: p.owned.map((r) => [r.index, r.rect, r.ink, r.advanceComplete]),
    anchor: p.anchor
  })
export async function recoverNativeClosedCaptionLane({
  page,
  candidate,
  tokens,
  context,
  anchors,
  otherCaptions,
  raster,
  loadPng
}) {
  try {
    if (
      typeof loadPng !== 'function' ||
      raster?.sourceSha256 !== context.sourceSha256 ||
      raster.page !== page.pageNumber ||
      raster.scale !== 1.5 ||
      raster.width !== Math.ceil(page.width * 1.5) ||
      raster.height !== Math.ceil(page.height * 1.5) ||
      raster.width * raster.height > 4000000 ||
      !/^[a-f\d]{64}$/u.test(raster.sha256 ?? '')
    )
      return
    if (
      !['width', 'height', 'scale', 'rotation', 'transform'].every((k) => {
        const d = Object.getOwnPropertyDescriptor(context.viewport, k)
        return d && 'value' in d
      })
    )
      return
    const guarded = context,
      converter = context.viewport.convertToViewportPoint,
      unchanged = retainNativeRecoveryInputs(
        [page, tokens, context, candidate, anchors, otherCaptions, raster, loadPng],
        context.viewport
      )
    if (!unchanged) return
    const p = plan(page, candidate, tokens, guarded, anchors, otherCaptions)
    if (!p) return
    const before = certificate(p),
      value = await loadPng()
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength > MAX_BYTES ||
      digest(value) !== raster.sha256 ||
      !unchanged() ||
      context.viewport.convertToViewportPoint !== converter ||
      !getPdfCropRasterProtectionFromPng(value, [0, 0, page.width, page.height], context.viewport)
    )
      return
    const bytes = Buffer.from(value),
      image = await loadImage(bytes)
    if (
      image.width !== raster.width ||
      image.height !== raster.height ||
      digest(value) !== raster.sha256 ||
      !unchanged() ||
      context.viewport.convertToViewportPoint !== converter
    )
      return
    const current = plan(page, candidate, tokens, guarded, anchors, otherCaptions)
    if (!current || certificate(current) !== before) return
    const sample = p.anchor.captionSeparation
      ? union([
          p.protection,
          [
            p.anchor.captionSeparation.bodyInk[0],
            p.anchor.captionSeparation.rule[1] - 1 / 1.5,
            p.anchor.captionSeparation.bodyInk[2],
            p.anchor.captionSeparation.rule[1] + 1 / 1.5
          ]
        ])
      : p.protection
    const x0 = Math.floor(sample[0] * 1.5),
      y0 = Math.floor(sample[1] * 1.5),
      x1 = Math.ceil(sample[2] * 1.5),
      y1 = Math.ceil(sample[3] * 1.5)
    if (
      x0 < 0 ||
      y0 < 0 ||
      x1 > image.width ||
      y1 > image.height ||
      (x1 - x0) * (y1 - y0) > MAX_BYTES / 8
    )
      return
    const canvas = createCanvas(image.width, image.height)
    try {
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      const pixels = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data,
        w = x1 - x0
      const dark = (x, y) => {
        if (x < x0 || x >= x1 || y < y0 || y >= y1) return false
        const i = ((y - y0) * w + x - x0) * 4
        return pixels[i + 3] === 255 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 192
      }
      if (p.anchor.captionSeparation) {
        const { rule, bodyInk } = p.anchor.captionSeparation
        for (let x = Math.ceil(bodyInk[0] * 1.5); x <= Math.floor(bodyInk[2] * 1.5); x++) {
          let hit = false
          for (let y = Math.floor(rule[1] * 1.5) - 1; y <= Math.ceil(rule[1] * 1.5) + 1; y++)
            if (dark(x, y)) {
              hit = true
              break
            }
          if (!hit) return
        }
      }
      for (const g of p.glyphs) {
        let hit = false
        for (let y = Math.floor(g.ink[1] * 1.5); !hit && y < Math.ceil(g.ink[3] * 1.5); y++)
          for (let x = Math.floor(g.ink[0] * 1.5); x < Math.ceil(g.ink[2] * 1.5); x++)
            if (dark(x, y)) {
              hit = true
              break
            }
        if (!hit) return
      }
    } finally {
      canvas.width = canvas.height = 0
    }
    if (
      !unchanged() ||
      context.viewport.convertToViewportPoint !== converter ||
      digest(value) !== raster.sha256
    )
      return
    const lines = p.rows.map((r) => r.text)
    const result = {
      ...candidate,
      lines,
      rect: p.rect,
      text: joinCaptionLines(lines, sourceWordSpellings(page.lines.map((l) => l.text)))
    }
    recoveredCaptions.set(result, {
      page,
      tokens,
      context,
      plan: p,
      unchanged,
      literal: JSON.stringify(result)
    })
    return result
  } catch {
    return
  }
}

// Only the same successful full-caption certificate can close this image-only
// recovery. No native text becomes a figure owner, and no clip or hash budget
// is widened. The caller publishes the crop only after its encoded PNG passes.
export async function recoverNativeClosedCaptionImage({
  page,
  figure,
  caption,
  tokens,
  context,
  otherCaptions,
  tables,
  renderCrop
}) {
  try {
    const proof = recoveredCaptions.get(caption)
    if (
      !proof ||
      proof.page !== page ||
      proof.tokens !== tokens ||
      proof.context !== context ||
      proof.plan.anchor.sourceOwner !== figure ||
      !proof.unchanged() ||
      JSON.stringify(caption) !== proof.literal ||
      figure.page !== page.pageNumber ||
      !valid(figure.region) ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.issue ||
      !Array.isArray(otherCaptions) ||
      !Array.isArray(tables) ||
      typeof renderCrop !== 'function'
    )
      return
    const p = proof.plan.packet,
      images = p.evidence.images,
      unchanged = retainNativeRecoveryInputs([figure, caption, otherCaptions, tables, renderCrop])
    if (
      !unchanged ||
      images.length !== 1 ||
      p.o.fnArray.some((op) =>
        [OPS.beginGroup, OPS.endGroup, OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd].includes(
          op
        )
      )
    )
      return
    const image = images[0],
      a = p.o.argsArray[image.operationIndex],
      actual = context.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === image.operationIndex
      ),
      inside = (outer, inner) => inner.every((n, i) => (i < 2 ? n >= outer[i] : n <= outer[i])),
      cap = p.records.filter((r) => inside(caption.rect, r.rect))
    if (
      !valid(image.rect) ||
      actual.length !== 1 ||
      !/^[a-f0-9]{64}$/u.test(actual[0].imageHash ?? '') ||
      a?.length !== 3 ||
      !Number.isSafeInteger(a[1]) ||
      !Number.isSafeInteger(a[2]) ||
      a[1] <= 0 ||
      a[2] <= 0 ||
      !cap.length ||
      !/^Figure\s+\d+:/u.test(cap[0].r.str) ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(caption.lines.join('')) ||
      !/[.!?]$/u.test(cap.at(-1).r.str) ||
      cap.some((r) => !r.advanceComplete || r.part.some((z) => z.g.i <= image.operationIndex))
    )
      return
    const foreign = []
    for (const r of p.records) {
      const style = context.content.styles[r.r.fontName],
        font = nativeFigureLabelBounds(r.r, style, p.v)
      if (!font || !valid(font)) return
      const domain = union([r.rect, font, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])])
      if (!valid(domain) || overlap(domain, image.rect)) return
      foreign.push({ rect: domain, floor: 0 })
    }
    for (const g of p.glyphs) {
      if (g.rendererSkipped) continue
      if (!valid(g.ink)) return
      foreign.push({ rect: g.ink, floor: 0 })
    }
    for (const [i, state] of p.evidence.paths) {
      const args = p.o.argsArray[i]
      if (
        args[0] === OPS.endPath ||
        (args[1]?.length === 1 && args[1][0] === null && args[2] === null)
      )
        continue
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint) return
      foreign.push(paint)
    }
    const scale = Math.ceil(page.width * 1.5) / page.width,
      expand = (rect, padding) => rect.map((n, i) => n + (i < 2 ? -padding : padding)),
      rect = expand(image.rect, 2 / scale),
      old = figure.region.map((n, i) => n * (i % 2 ? page.height : page.width))
    if (
      !inside([0, 0, page.width, page.height], rect) ||
      foreign.some((q) => overlap(rect, expand(q.rect, (q.floor + 2) / scale))) ||
      otherCaptions.some((c) => c.page === page.pageNumber && overlap(c.rect, rect)) ||
      tables.some((t) => overlap(t, rect)) ||
      (inside(old, image.rect) && !foreign.some((q) => overlap(old, q.rect)))
    )
      return
    const raster = { ownedRects: [image.rect], foreignPaints: foreign },
      png = await renderCrop(rect)
    if (
      !unchanged() ||
      !proof.unchanged() ||
      JSON.stringify(caption) !== proof.literal ||
      !nativeCompleteFormCropPngSafe(png, rect, page, { formCropRaster: raster })
    )
      return
    return {
      region: rect.map((n, i) => n / (i % 2 ? page.height : page.width)),
      graphicsCount: 1,
      png
    }
  } catch {
    return
  }
}

const inside = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]
const borderBox = (b, m) =>
  union(
    [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[0], b[3]],
      [b[2], b[3]]
    ].map((p) => {
      Util.applyTransform(p, m)
      return [p[0], p[1], p[0], p[1]]
    })
  )
function planClosedThreeRailCrop(page, tokens, context, table) {
  if (
    !table.caption ||
    table.page !== page.pageNumber ||
    !Array.isArray(table.cells) ||
    !table.cells.length ||
    !Array.isArray(table.cropRect) ||
    !table.sourceViewport
  )
    return
  const claims = table.cells.flatMap((c) => c.sourceItems ?? []),
    indices = new Set(claims.map((s) => s.index))
  if (
    indices.size !== claims.length ||
    claims.length > 64 ||
    claims.some((s) => s.pageNumber !== page.pageNumber)
  )
    return
  const p =
    nativeClosedProgramInkPacket(page, tokens, context, claims) ??
    nativeForeignCompoundInkPacket(page, tokens, context, claims)
  if (!p) return
  const body = p.records.filter((r) => indices.has(r.index))
  if (
    body.length !== claims.length ||
    body.some(
      (r) =>
        !r.advanceComplete ||
        !valid(r.ink) ||
        claims.find((s) => s.index === r.index)?.text !== r.r.str
    )
  )
    return
  const owners = new Map()
  for (const r of p.records)
    for (const g of new Set(r.part.map((z) => z.g))) {
      if (owners.has(g)) return
      owners.set(g, r.index)
    }
  const bodyInk = union(body.map((r) => r.ink)),
    old = table.cropRect.map((n) => n / 1.5),
    colors = new Map(),
    stack = []
  let stroke = '#000000'
  for (const [i, op] of p.o.fnArray.entries()) {
    const a = p.o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(stroke)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      stroke = stack.pop()
    } else if (op === OPS.setStrokeRGBColor) stroke = a?.[0]
    else if (op === OPS.constructPath) colors.set(i, stroke)
  }
  if (stack.length) return
  const rails = []
  for (const [i, q] of p.evidence.paths) {
    const a = p.o.argsArray[i],
      z = a?.[1]?.[0],
      m = Util.transform(p.v.transform, q.transform)
    if (a?.[0] !== OPS.stroke || z?.length !== 6 || z[0] !== 0 || z[3] !== 1) continue
    const s = [z[1], z[2]],
      e = [z[4], z[5]]
    Util.applyTransform(s, m)
    Util.applyTransform(e, m)
    if (s[1] !== e[1] || s[0] >= e[0] || s[0] >= bodyInk[0] || e[0] <= bodyInk[2]) continue
    if (
      colors.get(i) !== '#000000' ||
      q.lineCap !== 0 ||
      q.solidStroke !== true ||
      q.strokeAlpha !== 1 ||
      q.fillAlpha !== 1 ||
      !Number.isFinite(q.lineWidth) ||
      q.lineWidth <= 0 ||
      m[1] !== 0 ||
      m[2] !== 0 ||
      Math.abs(m[0]) !== 1 ||
      Math.abs(m[3]) !== 1
    )
      return
    const ink = [s[0], s[1] - q.lineWidth / 2, e[0], e[1] + q.lineWidth / 2]
    if (!(ink[1] < old[3] && ink[3] > old[1])) continue
    if (!valid(q.clip) || !inside(q.clip, ink)) return
    rails.push({ operatorIndex: i, segment: [...s, ...e], width: q.lineWidth, ink, clip: q.clip })
  }
  rails.sort((a, b) => a.segment[1] - b.segment[1])
  if (
    rails.length !== 3 ||
    rails.some(
      (r) => r.segment[0] !== rails[0].segment[0] || r.segment[2] !== rails[0].segment[2]
    ) ||
    rails[0].ink[3] >= bodyInk[1] ||
    rails[2].ink[1] <= bodyInk[3]
  )
    return
  const header = new Set(
    table.cells
      .filter((c) => c.row === 0)
      .flatMap((c) => c.sourceItems ?? [])
      .map((s) => s.index)
  )
  if (
    !header.size ||
    body.some((r) =>
      header.has(r.index) ? r.ink[3] >= rails[1].ink[1] : r.ink[1] <= rails[1].ink[3]
    )
  )
    return
  const ink = union([bodyInk, ...rails.map((r) => r.ink)]),
    aa = 1 / 4,
    rect = ink.map((n, i) => n + (i < 2 ? -aa : aa)),
    raster = getInitialPdfCropRaster(rect, page)
  if (!raster || raster.scale !== 4) return
  const owned = new Set(body.flatMap((r) => r.part.map((z) => z.g)))
  if (
    p.glyphs.some((g) => !owned.has(g) && valid(g.ink) && overlap(g.ink, raster.protection)) ||
    p.records.some(
      (r) => !indices.has(r.index) && valid(r.ink) && overlap(r.ink, raster.protection)
    ) ||
    p.evidence.images.some((im) => overlap(im.rect, raster.protection))
  )
    return
  const permitted = new Set(rails.map((r) => r.operatorIndex))
  for (const [i, q] of p.evidence.paths) {
    if (permitted.has(i)) continue
    const a = p.o.argsArray[i]
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    if (!a?.[2] || a[2].length !== 4) return
    const margin = [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0])
        ? (q.lineWidth * Math.max(1, p.strokeMargins.get(i) ?? 10)) / 2
        : 0,
      b = borderBox(
        Array.from(a[2], (n, k) => n + (k < 2 ? -margin : margin)),
        Util.transform(p.v.transform, q.transform)
      ),
      clipped = q.clip
        ? [
            Math.max(b[0], q.clip[0]),
            Math.max(b[1], q.clip[1]),
            Math.min(b[2], q.clip[2]),
            Math.min(b[3], q.clip[3])
          ]
        : b
    if (valid(clipped) && overlap(clipped, raster.protection)) return
  }
  return {
    rect,
    raster,
    rails,
    wholeBodySources: claims,
    bodyInk,
    glyphInks: [...owned].filter((g) => valid(g.ink)).map((g) => g.ink),
    oldModelFrame: table.cropRect,
    oldNativeCrop: old
  }
}

// The detector crop remains the model coordinate frame. Only the independent
// image region may grow after whole native owners and every stroke close.
export async function recoverNativeClosedTableBorder({ page, tokens, context, table, renderCrop }) {
  try {
    if (typeof renderCrop !== 'function') return
    const unchanged = retainNativeRecoveryInputs(
      [page, tokens, context, table, renderCrop],
      context.viewport
    )
    if (!unchanged) return
    const p = planClosedThreeRailCrop(page, tokens, context, table)
    if (!p) return
    const certificate = JSON.stringify(p),
      value = await renderCrop(p.rect)
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength > MAX_BYTES ||
      !unchanged() ||
      !matchesInitialPdfCropPng(value, p.raster)
    )
      return
    const current = planClosedThreeRailCrop(page, tokens, context, table)
    if (!current || JSON.stringify(current) !== certificate) return
    const bytes = Buffer.from(value),
      sha = digest(bytes),
      image = await loadImage(bytes)
    if (
      !unchanged() ||
      digest(value) !== sha ||
      image.width !== p.raster.pixelWidth ||
      image.height !== p.raster.pixelHeight
    )
      return
    const canvas = createCanvas(image.width, image.height)
    try {
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data,
        mask = new Uint8Array(image.width * image.height),
        scale = p.raster.scale
      const coordinates = (r) => [
        Math.max(0, Math.floor((r[0] - p.rect[0]) * scale) - 1),
        Math.max(0, Math.floor((r[1] - p.rect[1]) * scale) - 1),
        Math.min(image.width, Math.ceil((r[2] - p.rect[0]) * scale) + 1),
        Math.min(image.height, Math.ceil((r[3] - p.rect[1]) * scale) + 1)
      ]
      const dark = (x, y) => {
        const i = (y * image.width + x) * 4
        return pixels[i + 3] === 255 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 192
      }
      for (const ink of [...p.glyphInks, ...p.rails.map((r) => r.ink)]) {
        const [x0, y0, x1, y1] = coordinates(ink)
        let hit = false
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            mask[y * image.width + x] = 1
            if (dark(x, y)) hit = true
          }
        if (!hit) return
      }
      for (let i = 0; i < mask.length; i++)
        if (
          pixels[i * 4 + 3] !== 255 ||
          (!mask[i] && Math.min(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]) < 192)
        )
          return
      for (const r of p.rails) {
        const y = (r.segment[1] - p.rect[1]) * scale
        for (
          let x = Math.ceil((r.segment[0] - p.rect[0]) * scale);
          x < Math.floor((r.segment[2] - p.rect[0]) * scale);
          x++
        ) {
          let hit = false
          for (
            let yy = Math.max(0, Math.floor(y) - 1);
            yy <= Math.min(image.height - 1, Math.ceil(y) + 1);
            yy++
          )
            if (dark(x, yy)) hit = true
          if (!hit) return
        }
      }
    } finally {
      canvas.width = canvas.height = 0
    }
    if (!unchanged() || digest(value) !== sha) return
    return { region: p.rect.map((n, i) => n / (i % 2 ? page.height : page.width)), png: bytes }
  } catch {
    return
  }
}

const captionAnchorSourceItems = (owner, pageNumber) => {
  if (owner.cells !== undefined && !Array.isArray(owner.cells)) return
  const result = []
  for (const cell of owner.cells ?? []) {
    if (
      !cell ||
      typeof cell !== 'object' ||
      (cell.sourceItems !== undefined && !Array.isArray(cell.sourceItems))
    )
      return
    result.push(...(cell.sourceItems ?? []))
  }
  if (
    result.some(
      (s) =>
        !s ||
        s.pageNumber !== pageNumber ||
        !Number.isSafeInteger(s.index) ||
        s.index < 0 ||
        typeof s.text !== 'string'
    )
  )
    return
  return result
}
// A published image region never substitutes for the detector/model frame.
// Unsupported split or image-only tables decline without unioning their bounds.
export function nativeCaptionLaneAnchors(page, tables, figures, rules) {
  try {
    if (
      !Number.isSafeInteger(page?.pageNumber) ||
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height) ||
      page.width <= 0 ||
      page.height <= 0 ||
      !Array.isArray(tables) ||
      !Array.isArray(figures) ||
      !Array.isArray(rules) ||
      rules.some((r) => !finite(r, 4))
    )
      return []
    const anchors = []
    for (const table of tables) {
      if (
        !table ||
        table.page !== page.pageNumber ||
        !table.caption ||
        table.parts !== undefined ||
        table.cropRects !== undefined ||
        !valid(table.cropRect)
      )
        continue
      const frame = table.sourceViewport
      if (
        !Number.isFinite(frame?.scale) ||
        frame.scale <= 0 ||
        frame.width !== page.width * frame.scale ||
        frame.height !== page.height * frame.scale
      )
        continue
      const rect = table.cropRect.map((n) => n / frame.scale),
        sources = captionAnchorSourceItems(table, page.pageNumber)
      if (
        !valid(rect) ||
        rect[0] < 0 ||
        rect[1] < 0 ||
        rect[2] > page.width ||
        rect[3] > page.height ||
        !sources
      )
        continue
      anchors.push({
        page: page.pageNumber,
        kind: 'table',
        caption: table.caption,
        rect,
        sourceItems: sources,
        rules,
        sourceOwner: table
      })
    }
    for (const figure of figures) {
      if (
        !figure ||
        figure.page !== page.pageNumber ||
        !figure.caption ||
        !valid(figure.region) ||
        figure.region.some((n) => n < 0 || n > 1) ||
        (figure.sourceItems !== undefined && !Array.isArray(figure.sourceItems))
      )
        continue
      anchors.push({
        page: page.pageNumber,
        kind: 'figure',
        caption: figure.caption,
        rect: figure.region.map((n, i) => n * (i % 2 ? page.height : page.width)),
        sourceItems: figure.sourceItems ?? [],
        sourceOwner: figure
      })
    }
    return anchors
  } catch {
    return []
  }
}

// Metadata completion only: an exact tagged paragraph follows one isolated raster.
// Neither source ownership nor the ordinary caption/figure association is changed.
const equalTaggedCaptionValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function taggedCaptionFrameReferences(frame) {
  const refs = []
  for (const key of ['pageGeometry', 'context', 'nativeContent', 'nativePage']) {
    const descriptor = Object.getOwnPropertyDescriptor(frame, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return
    refs.push(descriptor.value)
  }
  refs.push(frame.nativePage.getStructTree, frame.nativePage.getTextContent)
  return refs
}
function taggedCaptionVisiblePacket(frame, marked) {
  const context = frame.context,
    o = context.operators,
    operators = [],
    markers = [],
    fnArray = [...o.fnArray]
  if (fnArray.length !== o.argsArray?.length || fnArray.length > 100000) return
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.beginMarkedContentProps) {
      if (
        !['Artifact', 'Span', 'P', 'Figure'].includes(a?.[0]) ||
        (a[0] === 'Artifact' ? a[1] != null : !Number.isSafeInteger(a[1]) || a[1] < 0)
      )
        return
      operators.push({ type: 'beginMarkedContentProps', tag: a[0], id: a[1] ?? null })
      fnArray[i] = OPS.dependency
    } else if (op === OPS.beginMarkedContent) {
      if (a?.[0]?.name !== 'Artifact') return
      operators.push({ type: 'beginMarkedContent', tag: 'Artifact' })
      fnArray[i] = OPS.dependency
    } else if (op === OPS.endMarkedContent) {
      operators.push({ type: 'endMarkedContent' })
      fnArray[i] = OPS.dependency
    } else if (op === OPS.setGState) {
      // These explicit resets leave the default renderer state unchanged.
      // A soft mask, opacity or compositing change is never projected away.
      if (
        !Array.isArray(a?.[0]) ||
        !a[0].length ||
        a[0].some(
          (entry) =>
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            !(
              (['ca', 'CA'].includes(entry[0]) && entry[1] === 1) ||
              (entry[0] === 'BM' && entry[1] === 'source-over') ||
              (entry[0] === 'SMask' && entry[1] === false)
            )
        )
      )
        return
      fnArray[i] = OPS.dependency
    }
  }
  for (const item of marked.items.filter((item) => item.type)) {
    if (item.type === 'beginMarkedContentProps') {
      const id = item.id === null ? null : /_mc(\d+)$/u.exec(item.id)?.[1]
      if (id === undefined) return
      markers.push({ type: item.type, tag: item.tag, id: id === null ? null : Number(id) })
    } else if (item.type === 'beginMarkedContent') markers.push({ type: item.type, tag: item.tag })
    else if (item.type === 'endMarkedContent') markers.push({ type: item.type })
    else return
  }
  if (!equalTaggedCaptionValue(operators, markers)) return
  // Preserve every native operation index, font, glyph, clip and transform.
  // Only the bound nonpainting metadata/reset operations become inert slots;
  // the unchanged public packet proves all remaining native paint and advances.
  const projected = { ...context, operators: { ...o, fnArray } },
    tokens = context.content.items
      .filter((item) => item.str?.trim())
      .map((item) => tableTextToken(item, context.viewport, 0)),
    packet = nativePageTextPacketInventory(frame.pageGeometry, tokens, projected, true)
  if (
    !packet ||
    packet.records.length !== tokens.length ||
    packet.records.some(
      (record) => !record.part.some(({ g }) => !g.rendererSkipped && valid(g.ink))
    ) ||
    packet.glyphs.some(
      (glyph) =>
        !glyph.rendererSkipped &&
        valid(glyph.ink) &&
        (glyph.textPaint?.fillAlpha !== 1 ||
          !/^#[a-f\d]{6}$/iu.test(glyph.textPaint.fillColor) ||
          glyph.textPaint.fillColor.toLowerCase() === '#ffffff')
    )
  )
    return
  return packet
}
function sameTaggedCaptionContent(a, b, allowFontAliases = false) {
  if (
    !Array.isArray(a?.items) ||
    !Array.isArray(b?.items) ||
    a.items.length !== b.items.length ||
    a.items.length > 4096 ||
    (!allowFontAliases && !equalTaggedCaptionValue(a.styles, b.styles))
  )
    return false
  const forward = new Map(),
    reverse = new Map()
  return a.items.every((r, i) => {
    const t = b.items[i]
    if (allowFontAliases) {
      if (
        !a.styles?.[r.fontName] ||
        !b.styles?.[t?.fontName] ||
        !equalTaggedCaptionValue(a.styles[r.fontName], b.styles[t.fontName]) ||
        (forward.has(r.fontName) && forward.get(r.fontName) !== t.fontName) ||
        (reverse.has(t.fontName) && reverse.get(t.fontName) !== r.fontName)
      )
        return false
      forward.set(r.fontName, t.fontName)
      reverse.set(t.fontName, r.fontName)
    }
    return (
      typeof r?.str === 'string' &&
      ['str', 'width', 'height', 'dir', 'hasEOL'].every((k) => r[k] === t?.[k]) &&
      (allowFontAliases || r.fontName === t?.fontName) &&
      equalTaggedCaptionValue(r.transform, t.transform)
    )
  })
}
function taggedCaptionParagraphs(tree, marked, content) {
  const roles = new Map(),
    queue = [[tree, undefined]],
    seen = new Set()
  let nodes = 0
  while (queue.length) {
    const [node, parent] = queue.pop()
    if (!node || typeof node !== 'object' || seen.has(node) || ++nodes > 256) return
    seen.add(node)
    if (node.type === 'content') {
      if (
        typeof node.id !== 'string' ||
        node.id.length > 160 ||
        roles.has(node.id) ||
        !['P', 'Figure'].includes(parent)
      )
        return
      roles.set(node.id, parent)
      continue
    }
    if (
      !['Root', 'Document', 'P', 'Figure'].includes(node.role) ||
      !Array.isArray(node.children) ||
      node.children.length > 64
    )
      return
    queue.push(
      ...node.children.map((c) => [
        c,
        node.role === 'Document' || node.role === 'Root' ? parent : node.role
      ])
    )
  }
  if (
    !roles.size ||
    !Array.isArray(marked?.items) ||
    marked.items.length > 8192 ||
    !sameTaggedCaptionContent(
      { ...marked, items: marked.items.filter((r) => typeof r?.str === 'string') },
      content
    )
  )
    return
  const stack = [],
    groups = new Map(),
    artifacts = []
  let index = 0
  for (const item of marked.items) {
    if (typeof item?.str === 'string') {
      const id = stack.at(-1),
        r = content.items[index++]
      if (item.str.trim() && !id && (!stack.length || stack.some(Boolean))) return
      if (id) groups.get(id).push(r)
      else artifacts.push(r)
      continue
    }
    if (item?.type === 'beginMarkedContentProps') {
      if (!['Artifact', 'Span', 'P', 'Figure'].includes(item.tag)) return
      if (item.id === null && item.tag === 'Artifact') stack.push(undefined)
      else {
        if (
          stack.some(Boolean) ||
          typeof item.id !== 'string' ||
          !roles.has(item.id) ||
          groups.has(item.id)
        )
          return
        groups.set(item.id, [])
        stack.push(item.id)
      }
    } else if (item?.type === 'beginMarkedContent' && item.tag === 'Artifact') stack.push(undefined)
    else if (item?.type === 'endMarkedContent') {
      if (!stack.length) return
      stack.pop()
    } else return
  }
  if (
    stack.length ||
    index !== content.items.length ||
    [...roles.keys()].some((id) => !groups.has(id))
  )
    return
  return [...roles]
    .map(([id, role]) => ({ id, role, items: groups.get(id) }))
    .concat({ role: 'Artifact', items: artifacts })
}
function taggedCaptionRaster(frame, groups) {
  const images = frame.pageGeometry.graphicsBounds,
    figures = groups.filter((g) => g.role === 'Figure'),
    o = frame.context.operators
  if (
    images.length !== 1 ||
    images[0].kind !== 'image' ||
    figures.length !== 1 ||
    figures[0].items.some((r) => r.str.trim()) ||
    !finite(images[0].normalizedRect, 4) ||
    !valid(images[0].normalizedRect)
  )
    return false
  const rect = images[0].normalizedRect,
    area = (rect[2] - rect[0]) * (rect[3] - rect[1])
  if (
    area < 0.5 ||
    area > 0.8 ||
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000
  )
    return false
  const mcid = /_mc(\d+)$/u.exec(figures[0].id)
  if (!mcid) return false
  const stack = []
  let count = 0
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.beginMarkedContentProps) {
      if (
        !(a?.[0] === 'Artifact' && a[1] == null) &&
        (!['P', 'Span', 'Figure'].includes(a?.[0]) || !Number.isSafeInteger(a?.[1]) || a[1] < 0)
      )
        return false
      stack.push(a[1] ?? null)
    } else if (op === OPS.beginMarkedContent) stack.push(null)
    else if (op === OPS.endMarkedContent) {
      if (!stack.length) return false
      stack.pop()
    } else if (op === OPS.paintImageXObject) {
      if (stack.at(-1) !== Number(mcid[1]) || images[0].operationIndex !== i || ++count !== 1)
        return false
    }
  }
  return !stack.length && count === 1
}
function taggedCaptionFooter(frame, groups) {
  const nonempty = groups.filter((g) => g.items.some((r) => r.str.trim())),
    matches = nonempty.filter(
      (g) =>
        g.role === 'Artifact' &&
        g.items.filter((r) => r.str.trim()).length === 1 &&
        /^[1-9]\d{0,3}$/u.test(g.items.find((r) => r.str.trim()).str)
    )
  if (matches.length !== 1) return
  const row = matches[0].items.find((r) => r.str.trim()),
    t = row.transform,
    v = frame.context.viewport,
    style = frame.nativeContent.styles[row.fontName]
  if (
    !finite(t, 6) ||
    t[0] !== t[3] ||
    t[0] <= 0 ||
    t[1] !== 0 ||
    t[2] !== 0 ||
    row.height !== t[3] ||
    !(row.width > 0) ||
    row.width >= row.height * 3 ||
    row.dir !== 'ltr' ||
    !Number.isFinite(style?.ascent) ||
    style.ascent <= 0 ||
    style.ascent > 2 ||
    !Number.isFinite(style.descent) ||
    style.descent > 0 ||
    style.vertical !== false ||
    v.height - t[5] - row.height <= v.height * 0.9 ||
    t[4] < v.width * 0.7
  )
    return
  const geometry = frame.pageGeometry.lines.filter((r) => r.text === row.str)
  if (
    geometry.length !== 1 ||
    [
      geometry[0].x - t[4],
      geometry[0].y - (v.height - t[5] - row.height),
      geometry[0].width - row.width,
      geometry[0].height - row.height,
      geometry[0].fontSize - row.height
    ].some((d) => !Number.isFinite(d) || Math.abs(d) > 1e-6)
  )
    return
  return { group: matches[0], row, number: Number(row.str) }
}
function taggedCaptionFrameValid(frame) {
  const p = frame?.pageGeometry,
    c = frame?.context,
    v = c?.viewport
  return (
    p &&
    p.rotation === 0 &&
    (p.renderRotation ?? 0) === 0 &&
    p.invalidGraphicsBounds === 0 &&
    Number.isSafeInteger(p.pageNumber) &&
    c?.pageNumber === p.pageNumber &&
    /^[a-f\d]{64}$/u.test(c.sourceSha256 ?? '') &&
    Array.isArray(p.graphicsBounds) &&
    equalTaggedCaptionValue(p.graphicsBounds, c.graphicsBounds) &&
    v?.scale === 1 &&
    v.rotation === 0 &&
    v.width === p.width &&
    v.height === p.height &&
    equalTaggedCaptionValue(v.transform, [1, 0, 0, -1, 0, p.height]) &&
    sameTaggedCaptionContent(frame.nativeContent, c.content, true) &&
    frame.nativePage?.pageNumber === p.pageNumber &&
    typeof frame.nativePage.getStructTree === 'function' &&
    typeof frame.nativePage.getTextContent === 'function'
  )
}
export async function recoverNativeTaggedRasterCaption({
  candidate,
  current,
  previous,
  otherCaptions
}) {
  try {
    if (
      !taggedCaptionFrameValid(current) ||
      !taggedCaptionFrameValid(previous) ||
      current.pageGeometry.pageNumber !== previous.pageGeometry.pageNumber + 1 ||
      current.context.sourceSha256 !== previous.context.sourceSha256 ||
      current.pageGeometry.width !== previous.pageGeometry.width ||
      current.pageGeometry.height !== previous.pageGeometry.height ||
      current.pageGeometry.graphicsBounds.length ||
      candidate?.page !== current.pageGeometry.pageNumber ||
      !valid(candidate.rect) ||
      !Array.isArray(candidate.lines) ||
      !candidate.lines.length ||
      !/^Figure\s+[A-Z]?\d+[.:]\s/u.test(candidate.lines[0]) ||
      !Array.isArray(otherCaptions) ||
      otherCaptions.length !== 1 ||
      otherCaptions[0] !== candidate
    )
      return
    const currentReferences = taggedCaptionFrameReferences(current),
      previousReferences = taggedCaptionFrameReferences(previous),
      referencesUnchanged = () =>
        currentReferences?.every(
          (value, index) => value === taggedCaptionFrameReferences(current)?.[index]
        ) &&
        previousReferences?.every(
          (value, index) => value === taggedCaptionFrameReferences(previous)?.[index]
        ) &&
        taggedCaptionFrameValid(current) &&
        taggedCaptionFrameValid(previous),
      unchanged = retainNativeRecoveryInputs(
        [
          candidate,
          current.pageGeometry,
          current.context,
          current.nativeContent,
          previous.pageGeometry,
          previous.context,
          previous.nativeContent,
          otherCaptions
        ],
        current.context.viewport
      )
    if (!unchanged || !referencesUnchanged()) return
    const data = await Promise.all([
      current.nativePage.getStructTree(),
      current.nativePage.getTextContent({ includeMarkedContent: true }),
      previous.nativePage.getStructTree(),
      previous.nativePage.getTextContent({ includeMarkedContent: true })
    ])
    if (!unchanged() || !referencesUnchanged()) return
    const cg = taggedCaptionParagraphs(data[0], data[1], current.nativeContent),
      pg = taggedCaptionParagraphs(data[2], data[3], previous.nativeContent)
    if (!cg || !pg || cg.length !== 3 || pg.length !== 3 || !taggedCaptionRaster(previous, pg))
      return
    if (
      !taggedCaptionVisiblePacket(current, data[1]) ||
      !taggedCaptionVisiblePacket(previous, data[3])
    )
      return
    const cf = taggedCaptionFooter(current, cg),
      pf = taggedCaptionFooter(previous, pg)
    if (
      !cf ||
      !pf ||
      cf.number !== pf.number + 1 ||
      !equalTaggedCaptionValue(cf.row.transform, pf.row.transform) ||
      cf.row.fontName !== pf.row.fontName ||
      cf.row.height !== pf.row.height ||
      !equalTaggedCaptionValue(
        current.nativeContent.styles[cf.row.fontName],
        previous.nativeContent.styles[pf.row.fontName]
      )
    )
      return
    const body = cg.filter((g) => g !== cf.group && g.items.some((r) => r.str.trim()))
    if (
      body.length !== 1 ||
      body[0].role !== 'P' ||
      pg.some((g) => g !== pf.group && g.role !== 'Figure' && g.items.some((r) => r.str.trim()))
    )
      return
    const runs = groupPageLines(current.pageGeometry),
      rows = runs.filter((r) => r.text !== cf.row.str),
      start = rows[0],
      em = start?.fontSize
    if (
      rows.length <= candidate.lines.length ||
      rows.length > 32 ||
      !start ||
      !(em > 0) ||
      start.y > current.pageGeometry.height * 0.15 ||
      rows.at(-1).bottom > current.pageGeometry.height * 0.3 ||
      !/[.!?]$/u.test(rows.at(-1).text.trim()) ||
      rows.at(-1).right >= start.right - em * 2 ||
      rows.some(
        (r, i) =>
          !finite([r.x, r.y, r.right, r.bottom], 4) ||
          r.fontSize !== em ||
          Math.abs(r.x - start.x) > em * 0.1 ||
          r.bottom - r.y < em ||
          r.bottom - r.y > em * 1.25 ||
          (i > 0 && (r.y <= rows[i - 1].bottom || r.y - rows[i - 1].y > em * 1.8)) ||
          (i < rows.length - 1 && r.right - r.x < (start.right - start.x) * 0.95)
      ) ||
      candidate.lines.some((s, i) => s !== rows[i]?.text) ||
      !equalTaggedCaptionValue(
        candidate.rect,
        union(rows.slice(0, candidate.lines.length).map((r) => [r.x, r.y, r.right, r.bottom]))
      ) ||
      compact(rows.map((r) => r.text).join('')) !==
        compact(body[0].items.map((r) => r.str).join(''))
    )
      return
    const rect = union(rows.map((r) => [r.x, r.y, r.right, r.bottom]))
    const bodySources = new Set(body[0].items),
      captionRows = current.pageGeometry.lines.filter((r) => r.text.trim() !== cf.row.str)
    if (
      !captionRows.length ||
      captionRows.some(
        (r) =>
          r.x < rect[0] - 1e-6 ||
          r.y < rect[1] - 1e-6 ||
          r.x + r.width > rect[2] + 1e-6 ||
          r.y + r.height > rect[3] + 1e-6
      ) ||
      bodySources.size !== body[0].items.length ||
      !unchanged() ||
      !referencesUnchanged()
    )
      return
    return { ...candidate, lines: rows.map((r) => r.text), rect }
  } catch {
    return
  }
}

const mathematicalCaptionAssociations = new WeakMap()
const sameMathematicalCaption = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const containsMathematicalCaption = (a, b) =>
  b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6))
const sortMathematicalCaptionSources = (values) => values.slice().sort()

// Associate a complete native mathematical caption packet without serializing
// its stacked mathematics. Only the exact native label becomes public text.
export function proveNativeMathematicalCaptionAssociation(scope) {
  const table = scope?.table
  try {
    const {
        page,
        context,
        tables,
        captions,
        competingRects,
        nativePage,
        nativeContent,
        sourceSha256
      } = scope,
      n = context.nativeGlyphContext,
      scale = context.viewport.scale
    assert(
      /^[a-f0-9]{64}$/u.test(sourceSha256) &&
        sourceSha256 === n.sourceSha256 &&
        page === context.sourcePage
    )
    assert(
      !table.caption &&
        table.captionIssue === 'no-adjacent-table-caption' &&
        !table.parts &&
        !table.nativeBody &&
        !table.cropRects &&
        valid(table.cropRect) &&
        table.sourceViewport?.scale === scale &&
        table.sourceViewport.width === context.viewport.width &&
        table.sourceViewport.height === context.viewport.height &&
        context.viewport.width === n.viewport.width * scale &&
        context.viewport.height === n.viewport.height * scale
    )
    assert(
      tables.filter((t) => t.page === table.page).length === 1 &&
        tables.includes(table) &&
        Array.isArray(competingRects) &&
        competingRects.length === 0
    )
    const candidates = captions.filter((c) => c.page === table.page)
    assert(candidates.length === 1)
    const candidate = candidates[0]
    assert(
      candidate.lines.length === 1 &&
        !candidate.regions &&
        valid(candidate.rect) &&
        /^(?:Table|Tab\.)\s+[A-Z]?\d+[.:]\s/u.test(candidate.lines[0])
    )
    assert(
      !n.operators.fnArray.some((op) =>
        [
          OPS.clip,
          OPS.eoClip,
          OPS.setGState,
          OPS.beginGroup,
          OPS.paintFormXObjectBegin,
          OPS.paintImageXObject,
          OPS.paintImageMaskXObject,
          OPS.paintInlineImageXObject
        ].includes(op)
      )
    )
    // The existing purpose forces the complete actual operator/font-ID bridge.
    // This branch explicitly refuses every clip and all compositing/image state.
    const witness = captureNativeTableCropWitness(
      table,
      context,
      { page, nativePage, nativeContent },
      'closed-ruled-body'
    )
    assert(witness && witness.patternOperations.length === 0 && witness.e.images.length === 0)
    const records = witness.records,
      labels = records.filter(
        (r) =>
          /^(?:Table|Tab\.)\s+[A-Z]?\d+[.:]$/u.test(r.text) &&
          candidate.lines[0].startsWith(r.text) &&
          Math.abs(r.sourceRect[0] - candidate.rect[0]) < 1e-6 &&
          Math.abs(r.sourceRect[1] - candidate.rect[1]) < 1e-6
      )
    assert(labels.length === 1)
    const label = labels[0],
      em = label.advance[3] - label.advance[1],
      band = [0, label.sourceRect[1] - em * 0.5, n.viewport.width, label.sourceRect[3] + em * 0.5]
    assert(em > 0)
    const owned = records.filter((r) => overlap(band, r.ink) || overlap(band, r.sourceRect))
    assert(
      owned.length >= 8 &&
        owned.length <= 128 &&
        owned[0] === label &&
        owned.every(
          (r) =>
            r.horizontalComplete &&
            containsMathematicalCaption(band, r.ink) &&
            containsMathematicalCaption(band, r.sourceRect)
        )
    )
    assert(
      owned.every((r) => {
        const h = r.advance[3] - r.advance[1]
        return (
          h >= em * 0.5 &&
          h <= em * 1.02 &&
          (h <= em * 0.8 || Math.abs(r.advance[3] - label.advance[3]) < 0.02)
        )
      })
    )
    assert(/[.!?]$/u.test(owned.at(-1).text))
    const selected = new Set(owned.map((r) => r.index)),
      first = label.index,
      last = owned.at(-1).index
    assert(
      records.filter((r) => r.index >= first && r.index <= last).every((r) => selected.has(r.index))
    )
    const prefix = []
    for (const r of owned) {
      prefix.push(r)
      const text = compact(prefix.map((r) => r.text).join(''))
      assert(compact(candidate.lines[0]).startsWith(text))
      if (text === compact(candidate.lines[0])) break
    }
    assert(
      compact(prefix.map((r) => r.text).join('')) === compact(candidate.lines[0]) &&
        prefix.length < owned.length
    )
    assert(
      union(prefix.map((r) => r.sourceRect)).every((x, i) => Math.abs(x - candidate.rect[i]) < 1e-6)
    )
    const rect = union(owned.flatMap((r) => [r.sourceRect, r.advance, r.ink]))
    assert(containsMathematicalCaption([0, 0, n.viewport.width, n.viewport.height], rect))
    const captionOps = new Set(owned.flatMap((r) => r.glyphOperations))
    assert(
      witness.glyphs
        .filter((g) => captionOps.has(g.op) && g.text.trim())
        .every((g) => sameMathematicalCaption(g.ink, g.clippedInk))
    )
    const paints = n.graphicsBounds.map((g) => {
      const a = n.operators.argsArray[g.operationIndex],
        state = witness.e.paths.get(g.operationIndex),
        q = Array.from(a?.[1]?.[0] ?? []),
        m = state && Util.transform(n.viewport.transform, state.transform)
      assert(
        g.kind === 'path' &&
          state &&
          a[0] === OPS.stroke &&
          q.length === 6 &&
          q[0] === 0 &&
          q[3] === 1 &&
          q.every(Number.isFinite) &&
          m[1] === 0 &&
          m[2] === 0 &&
          m[0] > 0 &&
          m[3] === -m[0] &&
          state.lineCap === 0 &&
          state.solidStroke &&
          state.strokeAlpha === 1 &&
          state.lineWidth > 0 &&
          state.lineWidth < em * 0.1
      )
      const p = [q[1], q[2]],
        z = [q[4], q[5]]
      Util.applyTransform(p, m)
      Util.applyTransform(z, m)
      assert(p[1] === z[1] && p[0] < z[0])
      const pad = (state.lineWidth * m[0]) / 2,
        ink = [p[0], p[1] - pad, z[0], z[1] + pad]
      assert(containsMathematicalCaption(state.clip, ink))
      return { operationIndex: g.operationIndex, line: [p[0], p[1], z[0], z[1]], ink }
    })
    const family = paints
      .filter((p) => p.line[1] > rect[3] && p.line[2] - p.line[0] >= em * 8)
      .sort((a, b) => a.line[1] - b.line[1])
    assert(family.length >= 3 && family.length <= 32)
    assert(
      family.every(
        (p) =>
          Math.abs(p.line[0] - family[0].line[0]) < 1e-6 &&
          Math.abs(p.line[2] - family[0].line[2]) < 1e-6
      )
    )
    const frame = [family[0].line[0], family[0].line[1], family[0].line[2], family.at(-1).line[1]],
      crop = table.cropRect.map((x) => x / scale)
    assert(
      containsMathematicalCaption(crop, union(family.map((p) => p.ink))) &&
        Math.abs((rect[0] + rect[2] - frame[0] - frame[2]) / 2) < 0.02 &&
        frame[1] - rect[3] >= em * 0.5 &&
        frame[1] - rect[3] <= em * 2
    )
    const foreign = records.filter((r) => !selected.has(r.index))
    assert(
      !foreign.some(
        (r) => overlap(rect, r.ink) || overlap([rect[0], rect[3], rect[2], frame[1]], r.ink)
      )
    )
    const previous = records.findLast((r) => r.index < first),
      next = records.find((r) => r.index > last)
    assert(previous && next && previous.ink[3] <= rect[1] - em * 0.5 && next.ink[1] >= frame[1])
    const captionPaths = paints.filter((p) => !family.includes(p))
    assert(captionPaths.length === 1)
    const bar = captionPaths[0]
    assert(
      containsMathematicalCaption(rect, bar.ink) &&
        bar.line[2] - bar.line[0] >= em * 0.1 &&
        bar.line[2] - bar.line[0] <= em
    )
    const numerator = owned.filter(
        (r) =>
          /^\d{1,3}$/u.test(r.text) &&
          r.ink[3] < bar.line[1] &&
          Math.abs(r.sourceRect[0] - bar.line[0]) < 0.02 &&
          Math.abs(r.sourceRect[2] - bar.line[2]) < 0.02
      ),
      denominator = owned.filter(
        (r) =>
          /^\d{1,3}$/u.test(r.text) &&
          r.ink[1] > bar.line[1] &&
          Math.abs(r.sourceRect[0] - bar.line[0]) < 0.02 &&
          Math.abs(r.sourceRect[2] - bar.line[2]) < 0.02
      )
    assert(numerator.length === 1 && denominator.length === 1)
    assert(
      !captionPaths.some((p) =>
        witness.glyphs.some((g) => captionOps.has(g.op) && g.text.trim() && overlap(p.ink, g.ink))
      )
    )
    const body = records.filter((r) => overlap(frame, r.ink))
    assert(
      body.length >= 6 &&
        body.every(
          (r) =>
            containsMathematicalCaption(frame, r.ink) &&
            containsMathematicalCaption(crop, r.sourceRect)
        )
    )
    const claims = new Set()
    for (const cell of table.cells) {
      assert(!cell.sourceSegments && cell.sourceRects?.length === (cell.sourceItems?.length ?? 0))
      for (const [i, s] of (cell.sourceItems ?? []).entries()) {
        const r = body.find((r) => r.index === s.index)
        assert(
          r &&
            s.pageNumber === table.page &&
            s.text === r.text &&
            !claims.has(r.index) &&
            r.sourceRect.every((x, k) => Math.abs(x * scale - cell.sourceRects[i][k]) < 1e-6)
        )
        claims.add(r.index)
      }
    }
    assert(
      claims.size >= 6 &&
        claims.size + (table.unassigned?.length ?? 0) === table.selectedTextItems &&
        sameMathematicalCaption(
          sortMathematicalCaptionSources(
            body.filter((r) => !claims.has(r.index)).map((r) => r.text)
          ),
          sortMathematicalCaptionSources(table.unassigned ?? [])
        )
    )
    const caption = { text: label.text, lines: [label.text], page: table.page, rect },
      proof = {
        caption,
        captionIssue: 'partial-table-caption',
        sourceIndexes: [...selected],
        tableFrame: frame,
        fractionOperation: bar.operationIndex
      },
      objects = () => [
        tables,
        captions,
        competingRects,
        ...tables,
        ...captions,
        ...competingRects,
        proof.caption,
        proof.caption.lines,
        proof.caption.rect,
        proof.sourceIndexes,
        proof.tableFrame
      ],
      refs = objects(),
      value = JSON.stringify({ proof, tables, captions, competingRects }),
      current = () =>
        witness.current() &&
        scope.table === table &&
        scope.sourceSha256 === sourceSha256 &&
        scope.context === context &&
        context.sourcePage === page &&
        scope.page === page &&
        scope.nativePage === nativePage &&
        scope.nativeContent === nativeContent &&
        scope.tables === tables &&
        scope.captions === captions &&
        scope.competingRects === competingRects &&
        objects().every((r, i) => r === refs[i]) &&
        JSON.stringify({ proof, tables, captions, competingRects }) === value
    assert(current())
    mathematicalCaptionAssociations.set(proof, {
      table,
      current,
      caption: structuredClone(caption)
    })
    return proof
  } catch {
    return
  }
}
export function commitNativeMathematicalCaptionAssociation(proof, target) {
  try {
    const state = mathematicalCaptionAssociations.get(proof)
    if (!state || state.table !== target || !state.current()) return
    return {
      ...state.table,
      caption: structuredClone(state.caption),
      captionIssue: 'partial-table-caption'
    }
  } catch {
    return
  }
}
