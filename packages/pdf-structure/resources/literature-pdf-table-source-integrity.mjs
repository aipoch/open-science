import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  nativeTableLayoutConflicts,
  nativeTableUnreliableMathSourceItems,
  visibleNativeHeaderRule
} from './literature-pdf-table-layout-conflicts.mjs'
import {
  preciseNativeGraphicsBounds,
  proveNativeFlattenedFraction,
  proveNativeFractionWarning
} from './literature-pdf-native-table-boundary-ink.mjs'
import { nativeFractionRowConflict } from './literature-pdf-native-fraction-row-conflict.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import {
  nativePageTextPacketInventory,
  nativeFractionInkPacket,
  nativeWholeCellInkPacket
} from './literature-pdf-figure-native-plot-labels.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import {
  nativeRecoveryOwnValues,
  retainNativeRecoveryInputs
} from './literature-pdf-native-figure-recovery-profile.mjs'

// A crop can start in one printed panel and continue into a different schema.
// Certify only the contradiction: never reconstruct fields or change owners.
function nativeCrossPanelFieldConflict(table, rules, context) {
  try {
    const t = nativeRecoveryOwnValues(table),
      c = nativeRecoveryOwnValues(context)
    if (
      !t ||
      !c ||
      t.parts ||
      !rect(t.cropRect) ||
      !Array.isArray(t.grid) ||
      t.grid.length < 2 ||
      !Array.isArray(t.grid[0]) ||
      t.grid[0].length < 2 ||
      !Array.isArray(t.cells) ||
      !Array.isArray(rules)
    )
      return false
    const groups = []
    for (const r of rules.filter((r) => rect(r) && r[1] === r[3] && r[0] < r[2])) {
      let group = groups.find(
        (g) => Math.abs(g[0][0] - r[0]) < 1e-6 && Math.abs(g[0][2] - r[2]) < 1e-6
      )
      if (!group) groups.push((group = []))
      group.push(r)
    }
    const frames = []
    for (const group of groups) {
      group.sort((a, b) => a[1] - b[1])
      for (let n = 0; n + 2 < group.length; n++) {
        const [top, divider, bottom] = group.slice(n, n + 3)
        if (divider[1] < t.cropRect[1] && bottom[1] > t.cropRect[1])
          frames.push({ top, divider, bottom })
      }
    }
    if (!frames.length) return false
    const native = c.nativeGlyphContext,
      raw = c.sourceContent,
      v = native?.viewport,
      scale = c.viewport?.scale,
      page = c.sourcePage
    if (
      !native ||
      !raw?.items ||
      !native.content?.items ||
      raw.items.length !== native.content.items.length ||
      c.content !== raw ||
      !(scale > 0) ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      c.viewport.rotation !== 0 ||
      !sameNumbers(v.transform, [1, 0, 0, -1, 0, v.height]) ||
      !sameNumbers(c.viewport.transform, [scale, 0, 0, -scale, 0, c.viewport.height]) ||
      page?.pageNumber !== t.page ||
      page.width !== v.width ||
      page.height !== v.height ||
      page.invalidGraphicsBounds !== 0
    )
      return false
    const retained = retainNativeRecoveryInputs(
      [
        table,
        rules,
        raw,
        page,
        {
          content: native.content,
          operators: native.operators,
          glyphBounds: native.glyphBounds,
          graphicsBounds: native.graphicsBounds,
          viewport: v,
          skippedSpaceGlyphs: native.skippedSpaceGlyphs
        }
      ],
      c.viewport,
      v
    )
    if (!retained) return false
    const forward = new Map(),
      backward = new Map()
    for (const [index, a] of native.content.items.entries()) {
      const b = raw.items[index],
        style = native.content.styles?.[a.fontName]
      if (
        !b ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => a[k] !== b[k]) ||
        JSON.stringify(a.transform) !== JSON.stringify(b.transform) ||
        JSON.stringify(style) !== JSON.stringify(raw.styles?.[b.fontName]) ||
        style?.vertical !== false ||
        !Number.isFinite(style.ascent) ||
        !(style.ascent > 0) ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        (forward.has(a.fontName) && forward.get(a.fontName) !== b.fontName) ||
        (backward.has(b.fontName) && backward.get(b.fontName) !== a.fontName) ||
        (a.str?.trim() &&
          (b.sourceItem?.pageNumber !== t.page ||
            b.sourceItem.index !== index ||
            b.sourceItem.text !== a.str))
      )
        return false
      forward.set(a.fontName, b.fontName)
      backward.set(b.fontName, a.fontName)
    }
    const content = {
        ...native.content,
        items: raw.items.map((item, index) => ({
          ...item,
          fontName: native.content.items[index].fontName
        }))
      },
      viewport = { ...v, convertToViewportPoint: (x, y) => [x, v.height - y] },
      packetContext = { ...native, content, viewport },
      tokens = content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, viewport, 0)),
      packet = nativePageTextPacketInventory(page, tokens, packetContext, true)
    if (!packet) return false
    const nativeRules = collectTableRules(native.operators, c.viewport),
      records = packet.records.map((r) => ({
        source: r.r.sourceItem,
        text: r.r.str,
        advance: r.rect.map((x) => x * scale),
        ink: [
          Math.min(...r.part.map((p) => p.g.ink[0])),
          Math.min(...r.part.map((p) => p.g.ink[1])),
          Math.max(...r.part.map((p) => p.g.ink[2])),
          Math.max(...r.part.map((p) => p.g.ink[3]))
        ].map((x) => x * scale)
      })),
      owned = new Set(),
      owners = new Map(),
      inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6))
    for (const cell of t.cells) {
      if (
        cell.sourceSegments?.length ||
        !Array.isArray(cell.sourceRects) ||
        (cell.sourceItems?.length ?? 0) !== cell.sourceRects.length ||
        (cell.text?.trim() && !cell.sourceItems?.length)
      )
        return false
      if (!cell.text?.trim()) continue
      if (
        !nativeWholeCellInkPacket(page, tokens, packetContext, {
          ...cell,
          sourceRects: cell.sourceRects.map((r) => r.map((x) => x / scale))
        })
      )
        return false
      const list = []
      for (const [index, origin] of cell.sourceItems.entries()) {
        const matches = records.filter(
          (r) => key(r.source) === key(origin) && r.source.text === origin.text
        )
        if (
          matches.length !== 1 ||
          owned.has(matches[0]) ||
          !sameNumbers(matches[0].advance, cell.sourceRects[index])
        )
          return false
        owned.add(matches[0])
        list.push(matches[0])
      }
      owners.set(cell, list)
    }
    for (const frame of frames) {
      if (
        [frame.top, frame.divider, frame.bottom].some(
          (r) => !nativeRules.some((n) => sameNumbers(r, n))
        )
      )
        continue
      const box = [frame.top[0], frame.top[1], frame.top[2], frame.bottom[1]],
        body = [box[0], frame.divider[1], box[2], box[3]],
        outside = [...owned].filter((r) => !inside(box, r.ink))
      if (
        !outside.length ||
        !groups.some(
          (g) =>
            g.length >= 3 &&
            g.every((r) => nativeRules.some((n) => sameNumbers(r, n))) &&
            [
              [g[0][0], g[0][1], g[0][2], g.at(-1)[1]],
              ...g.slice(2).map((r, i) => [g[i][0], g[i][1], r[2], r[1]])
            ].some(
              (box) =>
                (box[1] > frame.bottom[1] || box[3] < frame.top[1]) &&
                outside.every((r) => inside(box, r.ink))
            )
        )
      )
        continue
      const scoped = records.filter((r) => inside(box, r.advance)),
        lines = []
      for (const r of scoped.toSorted(
        (a, b) => a.advance[3] - b.advance[3] || a.advance[0] - b.advance[0]
      )) {
        const height = r.advance[3] - r.advance[1]
        let line = lines.find((l) => Math.abs(l[0].advance[3] - r.advance[3]) < height * 0.15)
        if (!line) lines.push((line = []))
        line.push(r)
      }
      const header = lines.filter((l) => l.every((r) => r.advance[3] < frame.divider[1])).at(-1),
        rows = lines.filter((l) => l.every((r) => inside(body, r.advance)))
      if (
        !header ||
        header.length <= t.grid[0].length ||
        header.length > 128 ||
        header.some((r) => !/[\p{L}\p{N}]/u.test(r.text)) ||
        rows.length < 2 ||
        rows.some((l) => l.length !== header.length)
      )
        continue
      const domains = header.map((r, column) => {
        const all = [r, ...rows.map((l) => l[column])]
        return [
          Math.min(...all.map((r) => r.advance[0])),
          Math.max(...all.map((r) => r.advance[2]))
        ]
      })
      if (domains.slice(1).some((d, i) => d[0] <= domains[i][1])) continue
      const cuts = [box[0], ...domains.slice(1).map((d, i) => (domains[i][1] + d[0]) / 2), box[2]],
        field = new Map()
      for (const line of [header, ...rows])
        for (const [column, r] of line.entries()) {
          if (!inside([cuts[column], box[1], cuts[column + 1], box[3]], r.advance)) return false
          field.set(r, column)
        }
      const conflicts = []
      for (const [cell, sources] of owners) {
        if (
          cell.rowSpan !== 1 ||
          cell.colSpan !== 1 ||
          !sources.length ||
          !sources.every((r) => field.has(r) && rows.some((l) => l.includes(r)))
        )
          continue
        const line = rows.find((l) => sources.every((r) => l.includes(r))),
          fields = [...new Set(sources.map((r) => field.get(r)))].sort((a, b) => a - b)
        if (line && fields.length > 1) conflicts.push({ cell, fields })
      }
      if (
        conflicts.some((a) =>
          conflicts.some(
            (b) =>
              a.cell.row !== b.cell.row &&
              a.cell.column === b.cell.column &&
              JSON.stringify(a.fields) === JSON.stringify(b.fields)
          )
        ) &&
        retained()
      )
        return true
    }
    return false
  } catch {
    return false
  }
}

function sameNumbers(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((x, i) => Number.isFinite(x) && Math.abs(x - b[i]) < 1e-6)
  )
}

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

// A scientific value contributes a numeric record only with a complete normal
// mantissa/base and one uniquely attached superscript exponent. This extends
// the existing repeated-row contradiction without lowering its leaf count.
function scientificRecordLines(fonts, inventory, h) {
  const normal = fonts.filter((f) => f.height >= h * 0.8),
    scripts = fonts.filter((f) => f.height < h * 0.8),
    domain = box(fonts),
    lines = []
  if (
    !scripts.length ||
    fonts.some(
      (f) =>
        !Number.isFinite(f.height) ||
        !Number.isFinite(f.baseline) ||
        !rect(f.rect) ||
        f.rect[2] <= f.rect[0] ||
        f.rect[3] <= f.rect[1]
    ) ||
    normal.some((f) => Math.abs(f.height - h) > h * 0.02) ||
    scripts.some((f) => f.height < h * 0.5) ||
    inventory.some(
      (f) =>
        !fonts.includes(f) &&
        f.text?.trim() &&
        (!rect(f.rect) ||
          f.rect[2] <= f.rect[0] ||
          f.rect[3] <= f.rect[1] ||
          (f.rect[0] < domain[2] &&
            f.rect[2] > domain[0] &&
            f.rect[1] < domain[3] &&
            f.rect[3] > domain[1]))
    )
  )
    return
  for (const f of [...normal].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = lines.at(-1)
    if (last && Math.abs(last.baseline - f.baseline) < h * 0.02) last.fonts.push(f)
    else lines.push({ baseline: f.baseline, fonts: [f], scripts: [], scientific: true })
  }
  if (lines.length < 2) return
  for (const script of scripts) {
    const owners = lines.filter(
      (line) =>
        line.baseline - script.baseline > h * 0.15 && line.baseline - script.baseline < h * 0.6
    )
    if (owners.length !== 1) return
    owners[0].scripts.push(script)
  }
  for (const line of lines) {
    const ordered = line.fonts.sort((a, b) => a.rect[0] - b.rect[0]),
      exponent = line.scripts.sort((a, b) => a.rect[0] - b.rect[0])
    if (
      !/^[+−-]?\d+(?:[.,]\d+)?×10$/u.test(
        ordered.map((f) => f.text.replace(/\s/gu, '')).join('')
      ) ||
      ordered.slice(1).some((f, i) => f.rect[0] - ordered[i].rect[2] > h * 0.5) ||
      !exponent.length ||
      !/^[+−-]?\d+$/u.test(exponent.map((f) => f.text.trim()).join('')) ||
      Math.abs(exponent[0].rect[0] - ordered.at(-1).rect[2]) > h * 0.03 ||
      exponent.some(
        (f) =>
          Math.abs(f.height - exponent[0].height) > h * 0.02 ||
          Math.abs(f.baseline - exponent[0].baseline) > h * 0.02
      ) ||
      exponent.slice(1).some((f, i) => Math.abs(f.rect[0] - exponent[i].rect[2]) > h * 0.03)
    )
      return
  }
  return lines
}

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
  const owners = new Map(),
    sourceClaims = new Map(),
    wholeClaims = new Set()
  for (const cell of table.cells) {
    for (const o of cell.sourceItems ?? []) {
      const k = key(o)
      owners.set(k, (owners.get(k) ?? 0) + 1)
    }
    // A whole source is exclusive even when a cell rectangle shows only part
    // of it. Only explicit source segments describe a character partition.
    for (const o of [...(cell.sourceItems ?? []), ...(cell.sourceSegments ?? [])]) {
      const k = key(o),
        f = native.get(k)
      if (
        !f ||
        counts.get(k) !== 1 ||
        !Number.isSafeInteger(o.pageNumber) ||
        o.pageNumber < 1 ||
        !Number.isSafeInteger(o.index) ||
        o.index < 0 ||
        !Number.isFinite(f.height) ||
        !Number.isFinite(f.baseline) ||
        f.rect[0] >= f.rect[2] ||
        f.rect[1] >= f.rect[3] ||
        f.text !== o.text ||
        f.sourceItem.text !== o.text
      )
        continue
      const claims = sourceClaims.get(k) ?? new Set()
      claims.add(cell)
      sourceClaims.set(k, claims)
      if (cell.sourceItems?.includes(o)) wholeClaims.add(k)
    }
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
  if ([...wholeClaims].some((k) => sourceClaims.get(k).size > 1))
    conflicts.add('native-whole-source-claimed-by-multiple-cells')
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
  if (repeatedNativeRecordAmbiguity(table, proved)) conflicts.add('collapsed-native-records')
  if (splitWrappedNativeStubRecords(table, proved)) conflicts.add('split-wrapped-native-records')
  if (crossedNativeIntervalRecords(table, proved, native, counts))
    conflicts.add('crossed-native-interval-records')
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
    const scientific = scientificRecordLines(fonts, inventory, h),
      records = scientific ?? lines
    if (
      records.length < 2 ||
      (!scientific && fonts.some((f) => f.height < h * 0.8)) ||
      records.slice(1).some((line, i) => line.baseline - records[i].baseline < h * 0.9) ||
      (!scientific &&
        records.some((line) => {
          const ordered = line.fonts.sort((a, b) => a.rect[0] - b.rect[0])
          return (
            !/^[+−-]?\d+(?:[.,]\d+)?%?[*∗]*$/u.test(ordered.map((f) => f.text.trim()).join('')) ||
            ordered.slice(1).some((f, i) => f.rect[0] - ordered[i].rect[2] > h * 0.5)
          )
        }))
    )
      continue
    const row = numericRows.get(cell.row) ?? []
    row.push({ column: cell.column, baselines: records.map((line) => line.baseline), h })
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

// An encoded control is not faithful Unicode cell text. This proves only that
// mapping must pause; it neither decodes the glyph nor proves a whole body crop.
function nativeEncodedSourceConflict(table, inventory, context) {
  // eslint-disable-next-line no-control-regex -- Deliberately excludes whitespace controls and C1.
  const control = /[\u0000-\u0008\u000e-\u001f]/u
  // eslint-disable-next-line no-control-regex -- A complete encoded source, never a borrowed text substring.
  const controlOnly = /^[\u0000-\u0008\u000e-\u001f]+$/u
  const content = context?.sourceContent,
    viewport = context?.viewport,
    transform = viewport?.transform
  if (
    !Number.isSafeInteger(table?.page) ||
    table.page < 1 ||
    !rect(table.cropRect) ||
    !table.cells?.length ||
    !Array.isArray(inventory) ||
    !Array.isArray(content?.items) ||
    !Array.isArray(transform) ||
    transform.length !== 6 ||
    !transform.every(Number.isFinite) ||
    viewport.rotation !== 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    !(viewport.width > 0 && viewport.height > 0) ||
    !(transform[0] > 0) ||
    transform[1] !== 0 ||
    transform[2] !== 0 ||
    transform[3] !== -transform[0]
  )
    return false
  const same = (a, b) => rect(a) && rect(b) && a.every((v, i) => v === b[i]),
    nativeViewport = {
      ...viewport,
      convertToViewportPoint: (x, y) => [
        x * transform[0] + y * transform[2] + transform[4],
        x * transform[1] + y * transform[3] + transform[5]
      ]
    }
  for (const cell of table.cells) {
    if (typeof cell.text !== 'string' || !control.test(cell.text)) continue
    for (const origin of [...(cell.sourceItems ?? []), ...(cell.sourceSegments ?? [])]) {
      if (
        origin.pageNumber !== table.page ||
        !Number.isSafeInteger(origin.index) ||
        origin.index < 0 ||
        typeof origin.text !== 'string' ||
        !controlOnly.test(origin.text) ||
        !cell.text.includes(origin.text) ||
        (cell.sourceSegments?.includes(origin) &&
          (origin.start !== 0 || origin.end !== origin.text.length))
      )
        continue
      const fonts = inventory.filter((f) => f.sourceItem && key(f.sourceItem) === key(origin)),
        raw = content.items.filter((r) => r.sourceItem && key(r.sourceItem) === key(origin))
      if (fonts.length !== 1 || raw.length !== 1) continue
      const f = fonts[0],
        item = raw[0],
        style = content.styles?.[item.fontName]
      if (
        f.text !== origin.text ||
        f.sourceItem.pageNumber !== origin.pageNumber ||
        f.sourceItem.index !== origin.index ||
        f.sourceItem.text !== origin.text ||
        item.str !== origin.text ||
        item.sourceItem.pageNumber !== origin.pageNumber ||
        item.sourceItem.index !== origin.index ||
        item.sourceItem.text !== origin.text ||
        !Number.isFinite(item.width) ||
        !Number.isFinite(item.height) ||
        !(item.width > 0 && item.height > 0) ||
        !Array.isArray(item.transform) ||
        item.transform.length !== 6 ||
        !item.transform.every(Number.isFinite) ||
        !Number.isFinite(style?.ascent) ||
        !(style.ascent > 0) ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        style.vertical !== false ||
        f.fontAscent !== style.ascent ||
        f.fontDescent !== style.descent
      )
        continue
      const token = tableTextToken(item, nativeViewport, 0)
      if (
        !f.horizontal ||
        !token.horizontal ||
        !Number.isFinite(f.baseline) ||
        !Number.isFinite(f.height) ||
        !(f.height > 0) ||
        f.baseline !== token.baseline ||
        f.height !== token.height ||
        !same(f.rect, token.rect) ||
        f.rect[2] <= f.rect[0] ||
        f.rect[3] <= f.rect[1] ||
        !cell.sourceRects?.some((r) => same(r, f.rect)) ||
        (cell.sourceSegments?.includes(origin) && !same(origin.rect, f.rect))
      )
        continue
      return true
    }
  }
  return false
}

export function reviewNativeTableSources(table, inventory) {
  // Let later native record recovery use its complete paint/source proof first.
  // Final assembly also attaches measured ranges before deciding whether a
  // candidate whole-source overlap remains. Do not persist a provisional warning.
  const conflicts = nativeTableSourceConflicts(table, inventory).filter(
    (conflict) =>
      conflict !== 'collapsed-numeric-records' &&
      conflict !== 'native-whole-source-claimed-by-multiple-cells'
  )
  return conflicts.length
    ? {
        ...table,
        issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
        reviewCandidate: false
      }
    : table
}

// A complete native mathematical cell can still have two incompatible text
// projections. Neither projection is a repair oracle for the other. Retain its
// original owners and image, and remove only the invalid optional formatting.
function nativeFormattedProjectionConflicts(table, inventory, context) {
  const content = context?.sourceContent,
    viewport = context?.viewport,
    page = table.page ?? context?.sourcePage?.pageNumber
  if (
    !content?.items ||
    !content.styles ||
    !viewport ||
    viewport.rotation !== 0 ||
    typeof viewport.convertToViewportPoint !== 'function' ||
    !Array.isArray(viewport.transform) ||
    viewport.transform.length !== 6 ||
    !viewport.transform.every(Number.isFinite) ||
    !Number.isSafeInteger(page)
  )
    return []
  const counts = new Map()
  for (const cell of table.cells ?? [])
    for (const origin of [...(cell.sourceItems ?? []), ...(cell.sourceSegments ?? [])])
      counts.set(key(origin), (counts.get(key(origin)) ?? 0) + 1)
  return (table.cells ?? []).flatMap((cell) => {
    if (
      !cell.textRuns?.some((run) => run.position !== 'normal') ||
      cell.textRuns.map((run) => run.text).join('') === cell.text ||
      cell.sourceSegments?.length ||
      !cell.sourceItems?.length ||
      cell.sourceItems.length > 64 ||
      cell.sourceRects?.length !== cell.sourceItems.length ||
      compact(cell.textRuns.map((run) => run.text).join('')) !==
        compact(cell.sourceItems.map((origin) => origin.text).join('')) ||
      cell.sourceItems.some((origin) => /\p{L}{3}/u.test(origin.text))
    )
      return []
    const fonts = []
    for (const origin of cell.sourceItems) {
      const native = inventory.filter((f) => f.sourceItem && key(f.sourceItem) === key(origin)),
        raw = content.items.filter(
          (item) => item.sourceItem && key(item.sourceItem) === key(origin)
        )
      if (native.length !== 1 || raw.length !== 1 || counts.get(key(origin)) !== 1) return []
      const f = native[0],
        item = raw[0],
        style = content.styles[item.fontName]
      if (
        origin.pageNumber !== page ||
        f.text !== origin.text ||
        f.sourceItem.text !== origin.text ||
        item.str !== origin.text ||
        item.sourceItem.text !== origin.text ||
        !f.horizontal ||
        !Number.isFinite(style?.ascent) ||
        !(style.ascent > 0) ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        style.vertical !== false ||
        f.fontAscent !== style.ascent ||
        f.fontDescent !== style.descent ||
        !Array.isArray(item.transform) ||
        item.transform.length !== 6 ||
        !item.transform.every(Number.isFinite) ||
        !(item.width > 0 && item.height > 0)
      )
        return []
      const token = tableTextToken(item, viewport, 0)
      if (
        !token.horizontal ||
        token.baseline !== f.baseline ||
        token.height !== f.height ||
        token.rect.some((n, axis) => n !== f.rect[axis]) ||
        !cell.sourceRects.some((r) => r.every((n, axis) => n === f.rect[axis]))
      )
        return []
      fonts.push(f)
    }
    const h = Math.max(...fonts.map((f) => f.height)),
      domain = box(fonts)
    if (
      !fonts.some(
        (f) =>
          f.height > h * 0.5 &&
          f.height < h * 0.85 &&
          fonts.some((base) => Math.abs(f.baseline - base.baseline) > f.height * 0.2)
      ) ||
      inventory.some(
        (f) =>
          f.text?.trim() &&
          !fonts.includes(f) &&
          (!rect(f.rect) ||
            (f.rect[0] < domain[2] &&
              f.rect[2] > domain[0] &&
              f.rect[1] < domain[3] &&
              f.rect[3] > domain[1]))
      )
    )
      return []
    return [{ cell, sources: cell.sourceItems }]
  })
}

// A separated, centred native page counter cannot establish a table record.
// Keep the whole original source component instead of remapping its formulae
// and the counter into a detector's otherwise apparently valid cell grid.
function nativeFolioCellConflict(table, inventory, rules, context) {
  const v = context?.viewport,
    page = table.page ?? context?.sourcePage?.pageNumber,
    content = context?.sourceContent
  if (
    table.caption ||
    !v ||
    v.rotation !== 0 ||
    typeof v.convertToViewportPoint !== 'function' ||
    !Array.isArray(v.transform) ||
    v.transform.length !== 6 ||
    !v.transform.every(Number.isFinite) ||
    ![v.width, v.height].every((n) => Number.isFinite(n) && n > 0) ||
    !Number.isSafeInteger(page) ||
    !content?.items ||
    !content.styles
  )
    return false
  const folios = inventory.filter(
    (f) =>
      f.horizontal &&
      f.text === String(page) &&
      f.sourceItem?.pageNumber === page &&
      f.sourceItem.text === f.text &&
      rect(f.rect) &&
      f.height > 0 &&
      f.rect[1] > v.height * 0.85 &&
      f.rect[3] < v.height &&
      Math.abs((f.rect[0] + f.rect[2] - v.width) / 2) < f.height * 0.05
  )
  if (folios.length !== 1) return false
  const f = folios[0],
    owners = table.cells.filter((cell) =>
      cell.sourceItems?.some((origin) => key(origin) === key(f.sourceItem))
    ),
    raw = content.items.filter(
      (item) => item.sourceItem && key(item.sourceItem) === key(f.sourceItem)
    )
  if (
    owners.length !== 1 ||
    owners[0].sourceSegments?.length ||
    owners[0].sourceItems.length !== 1 ||
    owners[0].sourceItems[0].text !== f.text ||
    compact(owners[0].text) !== f.text ||
    owners[0].sourceRects?.length !== 1 ||
    !owners[0].sourceRects[0].every((n, axis) => n === f.rect[axis]) ||
    raw.length !== 1 ||
    raw[0].str !== f.text ||
    raw[0].sourceItem.text !== f.text ||
    !Array.isArray(raw[0].transform) ||
    raw[0].transform.length !== 6 ||
    !raw[0].transform.every(Number.isFinite) ||
    !(raw[0].width > 0 && raw[0].height > 0)
  )
    return false
  const style = content.styles[raw[0].fontName],
    token = tableTextToken(raw[0], v, 0)
  if (
    !Number.isFinite(style?.ascent) ||
    !(style.ascent > 0) ||
    !Number.isFinite(style.descent) ||
    style.descent > 0 ||
    style.vertical !== false ||
    f.fontAscent !== style.ascent ||
    f.fontDescent !== style.descent ||
    !token.horizontal ||
    token.rect.some((n, axis) => n !== f.rect[axis])
  )
    return false
  const body = inventory.filter((other) => other !== f && other.text?.trim())
  const scale = Math.hypot(v.transform[0], v.transform[1]),
    peers = context.nativeFolioPages
  if (!Array.isArray(peers) || !(scale > 0)) return false
  const repeated = peers.filter((peer) => {
    if (
      peer.pageNumber === page ||
      !Number.isSafeInteger(peer.pageNumber) ||
      !(peer.pageNumber > 0) ||
      Math.abs(peer.width * scale - v.width) > 1e-5 ||
      Math.abs(peer.height * scale - v.height) > 1e-5 ||
      !Array.isArray(peer.lines) ||
      !peer.lines.length ||
      peer.lines.some(
        (line) =>
          typeof line.text !== 'string' ||
          ![line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite) ||
          !(line.width > 0 && line.height > 0 && line.fontSize > 0)
      )
    )
      return false
    const counters = peer.lines.filter((line) => line.text === String(peer.pageNumber))
    if (counters.length !== 1) return false
    const counter = counters[0]
    return (
      Math.abs(counter.y * scale - f.rect[1]) < 1e-5 &&
      Math.abs(counter.height * scale - f.height) < 1e-5 &&
      Math.abs(counter.fontSize * scale - f.height) < 1e-5 &&
      Math.abs((counter.x + counter.width / 2) * scale - (f.rect[0] + f.rect[2]) / 2) < 1e-5 &&
      peer.lines.every((line) => line === counter || line.y + line.height < counter.y)
    )
  })
  if (new Set(repeated.map((peer) => peer.pageNumber)).size < 2) return false
  const selected = [],
    seen = new Set()
  for (const cell of table.cells) {
    if (cell.sourceSegments?.length || cell.sourceRects?.length !== (cell.sourceItems?.length ?? 0))
      return false
    for (const origin of cell.sourceItems ?? []) {
      const fonts = inventory.filter(
          (other) => other.sourceItem && key(other.sourceItem) === key(origin)
        ),
        originals = content.items.filter(
          (item) => item.sourceItem && key(item.sourceItem) === key(origin)
        )
      if (
        seen.has(key(origin)) ||
        fonts.length !== 1 ||
        originals.length !== 1 ||
        origin.pageNumber !== page ||
        fonts[0].text !== origin.text ||
        fonts[0].sourceItem.text !== origin.text ||
        originals[0].str !== origin.text ||
        originals[0].sourceItem.text !== origin.text ||
        !fonts[0].horizontal ||
        !cell.sourceRects.some((r) => r.every((n, axis) => n === fonts[0].rect[axis]))
      )
        return false
      seen.add(key(origin))
      selected.push(fonts[0])
    }
  }
  return (
    table.grid.length >= 4 &&
    selected.filter((other) => /[=≤≥∈]/u.test(other.text)).length >= 3 &&
    selected.every((other) => !/\p{L}{4}/u.test(other.text)) &&
    body.length > 1 &&
    body.every(
      (other) =>
        rect(other.rect) &&
        other.sourceItem?.pageNumber === page &&
        other.rect[3] < f.rect[1] - f.height
    ) &&
    !rules.some((r) => !rect(r) || Math.max(r[1], r[3]) >= f.rect[1] - f.height)
  )
}

// Negative whole-source evidence only: retain every cell and native payload.
// Complete source intervals, or an attached native base/script pair, cannot be
// made reliable merely by assigning their pieces to independent model columns.
// Native flow can contradict a row partition without proving a replacement.
// Only the complete selected program is used; a failed whole-page packet is
// never promoted to positive crop or mathematical reconstruction evidence.
function nativeFlowPartitionConflict(
  table,
  selected,
  owners,
  originals,
  inventory,
  rules,
  context
) {
  try {
    const columns = table.grid[0].length,
      recordsShape = columns >= 3 && table.grid.length >= 4,
      mathShape = !table.caption && table.grid.length === 2 && columns >= 3
    if (
      (!recordsShape && !mathShape) ||
      table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1)
    )
      return false
    const native = context.nativeGlyphContext,
      page = context.sourcePage,
      scale = context.viewport.scale,
      retained = retainNativeRecoveryInputs(
        [
          table,
          inventory,
          rules,
          context.sourceContent,
          page,
          {
            content: native.content,
            operators: native.operators,
            glyphBounds: native.glyphBounds,
            graphicsBounds: native.graphicsBounds,
            viewport: native.viewport,
            skippedSpaceGlyphs: native.skippedSpaceGlyphs
          }
        ],
        context.viewport,
        native.viewport
      )
    if (!retained) return false
    const content = {
        ...native.content,
        items: native.content.items.map((n, index) =>
          n.str?.trim()
            ? { ...n, sourceItem: { pageNumber: page.pageNumber, index, text: n.str } }
            : n
        )
      },
      tokens = content.items
        .filter((n) => n.str?.trim())
        .map((n) => tableTextToken(n, native.viewport, 0)),
      claims = selected.map((f) => f.sourceItem),
      packet = nativeFractionInkPacket(page, tokens, { ...native, content }, claims),
      nativeRules = collectTableRules(native.operators, native.viewport).map((r) =>
        r.map((z) => z * scale)
      )
    if (
      !packet ||
      nativeRules.length !== rules.length ||
      rules.some((r) => !nativeRules.some((n) => sameNumbers(r, n)))
    )
      return false
    const records = new Map(),
      item = (f) => originals.get(f.sourceItem.index),
      cellFonts = (c) => selected.filter((f) => owners.get(key(f.sourceItem)) === c),
      at = (r, col) => table.cells.find((c) => c.row === r && c.column === col),
      eq = (a, b) => Math.abs(a - b) < 1e-6,
      valid = (r) => rect(r) && r[0] < r[2] && r[1] < r[3]
    for (const f of selected) {
      const matched = packet.records.filter((r) => r.index === f.sourceItem.index)
      if (
        matched.length !== 1 ||
        !valid(matched[0].rect) ||
        matched[0].part.some((p) => !valid(p.g.ink))
      )
        return false
      records.set(f, matched[0])
    }
    const ink = (f) => {
      const rs = records.get(f).part.map((p) => p.g.ink)
      return [
        Math.min(...rs.map((r) => r[0])),
        Math.min(...rs.map((r) => r[1])),
        Math.max(...rs.map((r) => r[2])),
        Math.max(...rs.map((r) => r[3]))
      ]
    }
    // A zero native advance is never converted into an ordinary source rect.
    // Only this negative witness may bind its one remote, fully painted glyph.
    // All legacy ownership/positive checks below still reject invalid geometry.
    const target = box([
        ...selected,
        ...selected.flatMap((f) => [
          { rect: records.get(f).rect.map((z) => z * scale) },
          { rect: ink(f).map((z) => z * scale) }
        ]),
        { rect: table.cropRect }
      ]).map((z) => z / scale),
      margin = Math.max(...selected.map((f) => f.height / scale))
    for (const f of inventory.filter((f) => f.text?.trim() && !valid(f.rect))) {
      const origin = f.sourceItem,
        raw = context.sourceContent.items[origin?.index],
        original = native.content.items[origin?.index]
      if (
        !origin ||
        origin.pageNumber !== page.pageNumber ||
        !Number.isSafeInteger(origin.index) ||
        origin.index < 0 ||
        inventory.filter((a) => a.sourceItem && key(a.sourceItem) === key(origin)).length !== 1 ||
        owners.has(key(origin)) ||
        !raw ||
        !original ||
        raw.str !== f.text ||
        origin.text !== raw.str ||
        raw.width !== 0 ||
        raw.height <= 0 ||
        raw.height !== original.height ||
        raw.fontName === undefined ||
        raw.str !== original.str ||
        raw.transform.some((z, i) => z !== original.transform[i]) ||
        !f.horizontal ||
        !rect(f.rect) ||
        f.rect[0] !== f.rect[2] ||
        f.rect[1] >= f.rect[3] ||
        !Number.isFinite(f.height) ||
        !Number.isFinite(f.baseline)
      )
        return false
      const canonical = tableTextToken(raw, context.viewport, 0),
        nativeCanonical = tableTextToken(original, native.viewport, 0)
      if (
        !canonical.horizontal ||
        !sameNumbers(canonical.rect, f.rect) ||
        !sameNumbers([canonical.height, canonical.baseline], [f.height, f.baseline]) ||
        !nativeCanonical.horizontal ||
        !rect(nativeCanonical.rect)
      )
        return false
      const matches = packet.glyphs.filter(
        (g) =>
          g.text === original.str &&
          g.fontName === original.fontName &&
          g.height === original.height &&
          sameNumbers(g.advance, nativeCanonical.rect)
      )
      if (matches.length !== 1) return false
      const g = matches[0],
        args = native.operators.argsArray[g.i],
        glyphs = Array.isArray(args?.[0]) ? args[0].filter((x) => x && typeof x === 'object') : []
      if (
        !valid(g.ink) ||
        !Number.isSafeInteger(g.i) ||
        native.operators.fnArray[g.i] !== OPS.showText ||
        packet.glyphs.filter((a) => a.i === g.i).length !== 1 ||
        !Array.isArray(args) ||
        args.length !== 1 ||
        glyphs.length !== 1 ||
        args[0].some((x) => (typeof x === 'number' ? !Number.isFinite(x) : x !== glyphs[0])) ||
        glyphs[0].unicode !== original.str ||
        glyphs[0].width !== 0 ||
        glyphs[0].isInFont !== true ||
        glyphs[0].accent !== null ||
        g.show.glyphs.length !== 1 ||
        g.show.i !== g.i ||
        g.show.fontName !== original.fontName ||
        g.show.size !== original.height ||
        native.content.items.filter(
          (n) =>
            n.str === original.str &&
            n.fontName === original.fontName &&
            n.height === original.height &&
            n.width === 0 &&
            sameNumbers(n.transform, original.transform)
        ).length !== 1 ||
        !(
          g.ink[2] < target[0] - margin ||
          g.ink[0] > target[2] + margin ||
          g.ink[3] < target[1] - margin ||
          g.ink[1] > target[3] + margin
        )
      )
        return false
    }
    if (recordsShape && table.caption) {
      const headers = table.cells.filter((c) => c.row === 0).flatMap(cellFonts)
      if (!headers.length || headers.some((f) => item(f).fontName !== item(headers[0]).fontName))
        return false
      const markerFont = item(headers[0]).fontName,
        starts = []
      for (const c of table.cells.filter((c) => c.column === 0 && c.row > 0)) {
        const fonts = cellFonts(c),
          a = fonts[0],
          b = fonts[1]
        if (!a || item(a).fontName !== markerFont) continue
        const aa = item(a),
          bb = b && item(b),
          space = context.sourceContent.items[a.sourceItem.index + 1]
        if (
          !b ||
          !/^\d+(?:\.\d+)+$/u.test(a.text) ||
          bb.fontName === markerFont ||
          b.sourceItem.index !== a.sourceItem.index + 2 ||
          space?.str !== ' ' ||
          !eq(aa.height, bb.height) ||
          !eq(aa.transform[5], bb.transform[5]) ||
          !eq(aa.transform[4] + aa.width, space.transform[4]) ||
          !eq(space.transform[4] + space.width, bb.transform[4])
        )
          return false
        starts.push({ c, a, b })
      }
      if (
        starts.length < 3 ||
        starts[0].c.row !== 1 ||
        starts.some(
          (s) =>
            !eq(item(s.a).transform[4], item(starts[0].a).transform[4]) ||
            item(s.b).fontName !== item(starts[0].b).fontName
        )
      )
        return false
      let contradictions = 0
      for (let n = 0; n < starts.length; n++) {
        const start = starts[n],
          end = starts[n + 1]?.c.row ?? table.grid.length
        if (end <= start.c.row + 1) continue
        const following = at(start.c.row + 1, 0),
          first = following && cellFonts(following)[0]
        if (
          !first ||
          item(first).fontName !== item(start.b).fontName ||
          !eq(item(first).transform[4], item(start.a).transform[4])
        )
          return false
        for (let column = 0; column < columns; column++) {
          const upper = at(start.c.row, column),
            lower = at(start.c.row + 1, column),
            aa = upper && cellFonts(upper).at(-1),
            bb = lower && cellFonts(lower)[0]
          if (
            !aa ||
            !bb ||
            aa.sourceItem.index + 1 !== bb.sourceItem.index ||
            item(aa).fontName !== item(bb).fontName ||
            item(aa).height !== item(bb).height ||
            item(aa).transform[5] - item(bb).transform[5] <= item(aa).height ||
            item(aa).transform[5] - item(bb).transform[5] >= item(aa).height * 1.5
          )
            return false
        }
        contradictions++
      }
      const body = box(selected.filter((f) => owners.get(key(f.sourceItem)).row > 0)),
        horizontal = rules.filter(
          (r) => r[1] === r[3] && r[0] <= body[0] + 1e-6 && r[2] >= body[2] - 1e-6
        )
      if (
        contradictions >= 2 &&
        horizontal.length === 3 &&
        horizontal.filter((r) => r[1] < body[1]).length === 2 &&
        horizontal.filter((r) => r[1] > body[3]).length === 1 &&
        rules.every((r) => r[1] === r[3]) &&
        retained()
      )
        return true
    }
    if (mathShape && !rules.length) {
      const label = at(1, 0),
        labelFonts = label && cellFonts(label)
      if (!labelFonts?.length || !/^\(\d+(?:\.\d+)*\)$/u.test(label.text)) return false
      const crossings = []
      for (const c of table.cells.filter((c) => c.row === 0 && c.column > 0)) {
        const lower = at(1, c.column),
          below = lower && cellFonts(lower)
        if (!below?.length) continue
        for (const f of cellFonts(c)) {
          const bounds = ink(f),
            height = item(f).height
          const base = below.find(
            (b) => item(b).height === height && bounds[1] < ink(b)[3] && bounds[3] > ink(b)[1]
          )
          if (
            base &&
            bounds[3] - bounds[1] > height * 1.2 &&
            below.some((s) => item(s).height < height * 0.8 && item(s).height > height * 0.5)
          )
            crossings.push({ f, bounds, base, tall: bounds[3] - bounds[1] > height * 2 })
        }
      }
      if (
        crossings.some(
          (a) =>
            a.tall &&
            crossings.some(
              (b) =>
                owners.get(key(a.f.sourceItem)).column !== owners.get(key(b.f.sourceItem)).column &&
                eq(item(a.base).transform[5], item(b.base).transform[5])
            )
        ) &&
        retained()
      )
        return true
    }
    return false
  } catch {
    return false
  }
}

// A single logical row cannot own fields on both sides of a separately
// painted full-width row separator. Certify the contradiction, never a grid.
function nativeCollapsedRuledRecordConflict(table, selected, owners, inventory, rules, context) {
  try {
    const native = context.nativeGlyphContext,
      page = context.sourcePage,
      v = native.viewport,
      scale = context.viewport.scale
    if (
      table.grid[0].length < 3 ||
      table.grid.length < 3 ||
      native.pageNumber !== table.page ||
      JSON.stringify(page.graphicsBounds) !== JSON.stringify(native.graphicsBounds) ||
      !Array.isArray(native.operators?.fnArray) ||
      !Array.isArray(native.operators?.argsArray)
    )
      return false
    const retained = retainNativeRecoveryInputs(
      [
        table,
        inventory,
        rules,
        page,
        native.content,
        native.operators,
        native.glyphBounds,
        native.graphicsBounds,
        native.skippedSpaceGlyphs,
        context.viewport,
        v
      ],
      context.viewport,
      v
    )
    if (!retained) return false
    const content = {
        ...native.content,
        items: context.sourceContent.items.map((i, index) => ({
          ...i,
          fontName: native.content.items[index].fontName
        }))
      },
      viewport = { ...v, convertToViewportPoint: (x, y) => [x, v.height - y] },
      tokens = content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, viewport, 0)),
      packet = nativePageTextPacketInventory(page, tokens, { ...native, content, viewport }, true),
      paintMap = new Map(),
      nativeRules = collectTableRules(native.operators, context.viewport, paintMap)
    if (!packet) return false
    const identity = native.graphicsBounds.map((g) => ({
        kind: g.kind,
        operationIndex: g.operationIndex,
        rect: g.normalizedRect.map((x, i) => x * (i % 2 ? v.height : v.width) * scale)
      })),
      precise = preciseNativeGraphicsBounds({
        nativeGlyphContext: native,
        viewport: context.viewport,
        rulePaintBounds: paintMap,
        nativePaintIdentityGraphics: identity,
        nativeEvidenceGraphics: identity
      })
    if (
      precise.length !== identity.length ||
      precise.some((r) => !rect(r) || r[0] >= r[2] || r[1] >= r[3])
    )
      return false
    const visibilityContext = {
        operators: native.operators,
        viewport: context.viewport,
        rulePaintBounds: paintMap,
        nativePaintIdentityGraphics: identity.map((g, i) => ({ ...g, rect: precise[i] }))
      },
      envelopes = packet.records.map((r) => {
        const a = r.rect.map((x) => x * scale),
          p = r.part.map((x) => x.g.ink)
        return {
          envelope: [
            Math.min(a[0], ...p.map((x) => x[0] * scale)),
            Math.min(a[1], ...p.map((x) => x[1] * scale)),
            Math.max(a[2], ...p.map((x) => x[2] * scale)),
            Math.max(a[3], ...p.map((x) => x[3] * scale))
          ]
        }
      })
    const records = new Map()
    for (const f of selected) {
      const matches = packet.records.filter(
        (r) =>
          r.index === f.sourceItem.index &&
          r.r.str === f.text &&
          r.rect.every((z, i) => Math.abs(z * scale - f.rect[i]) < 1e-6)
      )
      if (matches.length !== 1) return false
      records.set(f, matches[0])
    }
    // A remote zero metric remains a glyph witness, never a font proof.
    const selectedIds = new Set(selected.map((f) => f.sourceItem.index))
    for (const r of packet.records) {
      const style = content.styles[r.r.fontName]
      if (style?.ascent > 0 && Number.isFinite(style.descent) && style.descent <= 0) continue
      if (selectedIds.has(r.index)) return false
      const pieces = [r.rect, ...r.part.map((p) => p.g.ink)].map((a) => a.map((z) => z * scale))
      if (
        pieces.some(
          (a) =>
            !rect(a) ||
            a[0] >= a[2] ||
            a[1] >= a[3] ||
            (a[0] < table.cropRect[2] &&
              a[2] > table.cropRect[0] &&
              a[1] < table.cropRect[3] &&
              a[3] > table.cropRect[1])
        )
      )
        return false
    }
    const bands = (fonts) => {
        const lanes = []
        for (const f of fonts) {
          let lane = lanes.find((l) => Math.abs(l.baseline - f.baseline) < 1e-6)
          if (!lane) lanes.push((lane = { baseline: f.baseline, fonts: [] }))
          lane.fonts.push(f)
        }
        return lanes.sort((a, b) => a.baseline - b.baseline)
      },
      ink = (f) => {
        const rs = records.get(f).part.map((p) => p.g.ink)
        return [
          Math.min(...rs.map((r) => r[0])) * scale,
          Math.min(...rs.map((r) => r[1])) * scale,
          Math.max(...rs.map((r) => r[2])) * scale,
          Math.max(...rs.map((r) => r[3])) * scale
        ]
      }
    for (let row = 1; row < table.grid.length; row++) {
      const cells = table.cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
      if (
        cells.length !== table.grid[0].length ||
        cells.some((c, i) => c.column !== i || c.rowSpan !== 1 || c.colSpan !== 1)
      )
        continue
      const lanes = cells.map((c) => selected.filter((f) => owners.get(key(f.sourceItem)) === c)),
        all = lanes.flat()
      if (lanes.some((l) => !l.length)) continue
      const bound = box(all)
      for (const rule of rules.filter(
        (r) =>
          rect(r) &&
          r[1] === r[3] &&
          r[0] <= bound[0] &&
          r[2] >= bound[2] &&
          r[1] > bound[1] &&
          r[1] < bound[3]
      )) {
        if (nativeRules.filter((r) => sameNumbers(r, rule)).length !== 1) continue
        const paint = paintMap.get(rule.join(','))
        if (
          !rect(paint) ||
          paint[1] >= paint[3] ||
          visibleNativeHeaderRule(rule, visibilityContext, envelopes) !== true
        )
          continue
        const paths = [...packet.evidence.paths].filter(([op, state]) => {
          const a = native.operators.argsArray[op],
            q = Array.from(a?.[1]?.[0] ?? [])
          if (
            native.operators.fnArray[op] !== OPS.constructPath ||
            a?.[0] !== OPS.stroke ||
            q.length !== 6 ||
            !q.every(Number.isFinite) ||
            q[0] !== 0 ||
            q[3] !== 1 ||
            state.lineCap !== 0 ||
            !state.solidStroke ||
            state.strokeAlpha !== 1 ||
            !sameNumbers(state.transform.slice(0, 4), [1, 0, 0, 1]) ||
            !sameNumbers(state.clip, [0, 0, v.width, v.height])
          )
            return false
          const x0 = (q[1] + state.transform[4]) * scale,
            x1 = (q[4] + state.transform[4]) * scale,
            y0 = (v.height - q[2] - state.transform[5]) * scale,
            y1 = (v.height - q[5] - state.transform[5]) * scale,
            half = (state.lineWidth * scale) / 2
          return (
            half > 0 &&
            y0 === y1 &&
            sameNumbers([x0, y0, x1, y1], rule) &&
            sameNumbers([x0, y0 - half, x1, y0 + half], paint)
          )
        })
        if (paths.length !== 1) continue
        const split = lanes.map((fonts) => ({
            above: fonts.filter((f) => Math.max(f.rect[3], ink(f)[3]) < paint[1]),
            below: fonts.filter((f) => Math.min(f.rect[1], ink(f)[1]) > paint[3])
          })),
          crossing = split.filter(
            (s, i) =>
              s.above.length &&
              s.below.length &&
              s.above.length + s.below.length === lanes[i].length
          )
        if (
          crossing.length < 2 ||
          split.every((s) => s.below.length) ||
          split.some((s, i) => s.above.length + s.below.length !== lanes[i].length)
        )
          continue
        const repeated = crossing.map((s) => bands(s.above)),
          lower = crossing.map((s) => bands(s.below))
        if (
          repeated.some((a) => a.length < 2) ||
          lower.some((a) => a.length !== 1) ||
          repeated.some(
            (a) =>
              a.length !== repeated[0].length ||
              a.some((b, i) => Math.abs(b.baseline - repeated[0][i].baseline) > 1e-6)
          ) ||
          lower.some((a) => Math.abs(a[0].baseline - lower[0][0].baseline) > 1e-6)
        )
          continue
        return retained()
      }
    }
    return false
  } catch {
    return false
  }
}

// A painted header divider cannot split sources in one non-spanning first-row owner.
// This is negative ownership evidence only; no replacement grid is inferred.
function nativeHeaderFirstRecordConflict(table, selected, owners, inventory, rules, context) {
  try {
    const native = context.nativeGlyphContext,
      page = context.sourcePage,
      v = native.viewport,
      scale = context.viewport.scale,
      columns = table.grid[0].length
    if (
      columns < 3 ||
      table.grid.length < 2 ||
      rules.length < 3 ||
      table.cells.length !== columns * table.grid.length ||
      table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1 || !c.sourceItems?.length) ||
      rules.some((r) => !rect(r) || r[1] !== r[3] || r[0] >= r[2]) ||
      native.pageNumber !== table.page ||
      JSON.stringify(page.graphicsBounds) !== JSON.stringify(native.graphicsBounds)
    )
      return false
    const retained = retainNativeRecoveryInputs(
      [
        table,
        inventory,
        rules,
        context.sourceContent,
        page,
        native.content,
        native.operators,
        native.glyphBounds,
        native.graphicsBounds,
        native.skippedSpaceGlyphs,
        context.viewport,
        v
      ],
      context.viewport,
      v
    )
    if (!retained) return false
    const content = {
        ...native.content,
        items: context.sourceContent.items.map((i, index) => ({
          ...i,
          fontName: native.content.items[index].fontName
        }))
      },
      viewport = { ...v, convertToViewportPoint: (x, y) => [x, v.height - y] },
      tokens = content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, viewport, 0)),
      packet = nativePageTextPacketInventory(page, tokens, { ...native, content, viewport }, true),
      paintMap = new Map(),
      nativeRules = collectTableRules(native.operators, context.viewport, paintMap)
    if (
      !packet ||
      nativeRules.length !== rules.length ||
      rules.some((r) => nativeRules.filter((n) => sameNumbers(n, r)).length !== 1)
    )
      return false
    const identity = native.graphicsBounds.map((g) => ({
        kind: g.kind,
        operationIndex: g.operationIndex,
        rect: g.normalizedRect.map((x, i) => x * (i % 2 ? v.height : v.width) * scale)
      })),
      precise = preciseNativeGraphicsBounds({
        nativeGlyphContext: native,
        viewport: context.viewport,
        rulePaintBounds: paintMap,
        nativePaintIdentityGraphics: identity,
        nativeEvidenceGraphics: identity
      })
    if (
      precise.length !== identity.length ||
      precise.some((r) => !rect(r) || r[0] >= r[2] || r[1] >= r[3])
    )
      return false
    const visibility = {
        operators: native.operators,
        viewport: context.viewport,
        rulePaintBounds: paintMap,
        nativePaintIdentityGraphics: identity.map((g, i) => ({ ...g, rect: precise[i] }))
      },
      envelopes = packet.records.map((r) => ({
        envelope: box([{ rect: r.rect }, ...r.part.map((p) => ({ rect: p.g.ink }))]).map(
          (z) => z * scale
        )
      })),
      bounds = box(selected),
      rails = rules
        .filter((r) => r[0] <= bounds[0] && r[2] >= bounds[2])
        .sort((a, b) => a[1] - b[1]),
      middle = rails[1],
      paint = paintMap.get(middle.join(','))
    if (
      rails.length !== 3 ||
      rails.some((r) => r[0] !== rails[0][0] || r[2] !== rails[0][2]) ||
      rails.some((r) => visibleNativeHeaderRule(r, visibility, envelopes) !== true) ||
      !rect(paint) ||
      paint[1] >= paint[3]
    )
      return false
    const records = new Map()
    for (const f of selected) {
      const rr = packet.records.filter(
        (r) =>
          r.index === f.sourceItem.index &&
          r.r.str === f.text &&
          r.rect.every((z, i) => Math.abs(z * scale - f.rect[i]) < 1e-6)
      )
      if (
        rr.length !== 1 ||
        rr[0].part.some(
          (p) => !rect(p.g.ink) || p.g.ink[0] >= p.g.ink[2] || p.g.ink[1] >= p.g.ink[3]
        )
      )
        return false
      records.set(f, rr[0])
    }
    const ids = new Set(selected.map((f) => f.sourceItem.index)),
      frame = [rails[0][0], rails[0][1], rails[0][2], rails[2][1]],
      disjoint = (r) => r[2] <= frame[0] || r[0] >= frame[2] || r[3] <= frame[1] || r[1] >= frame[3]
    if (
      packet.records.some(
        (r) =>
          !ids.has(r.index) &&
          [r.rect, ...r.part.map((p) => p.g.ink)].some((a) => !disjoint(a.map((z) => z * scale)))
      )
    )
      return false
    const ink = (f) =>
        box(records.get(f).part.map((p) => ({ rect: p.g.ink }))).map((z) => z * scale),
      above = (f) => Math.max(f.rect[3], ink(f)[3]) < paint[1],
      below = (f) => Math.min(f.rect[1], ink(f)[1]) > paint[3],
      at = (row, col) => table.cells.find((c) => c.row === row && c.column === col),
      fonts = (c) => selected.filter((f) => owners.get(key(f.sourceItem)) === c),
      top = Array.from({ length: columns }, (_, col) => fonts(at(0, col))),
      crosses = top.filter((ff) => ff.some(above) && ff.some(below)),
      sameBaseline = (ff) =>
        ff.length && ff.every((f) => Math.abs(f.baseline - ff[0].baseline) < 1e-6)
    if (
      top.some((ff) => !ff.length || !ff.some(below) || ff.some((f) => !above(f) && !below(f))) ||
      crosses.length < 2 ||
      !sameBaseline(crosses.flatMap((ff) => ff.filter(above))) ||
      !sameBaseline(top.flatMap((ff) => ff.filter(below)))
    )
      return false
    const all = box(selected.flatMap((f) => [{ rect: f.rect }, { rect: ink(f) }]))
    if (
      all[0] < table.cropRect[0] ||
      all[1] < table.cropRect[1] ||
      all[2] > table.cropRect[2] ||
      all[3] > table.cropRect[3] ||
      rails.some((r) => r[1] <= table.cropRect[1] || r[1] >= table.cropRect[3])
    )
      return false
    const crossesFrame = (r) =>
      r[0] < frame[2] && r[2] > frame[0] && r[1] < frame[3] && r[3] > frame[1]
    if (
      rules.some((r) => !rails.includes(r) && crossesFrame(r)) ||
      precise.some(
        (r) =>
          !rails.some((rail) => sameNumbers(r, paintMap.get(rail.join(',')))) && crossesFrame(r)
      )
    )
      return false

    if (all[0] < frame[0] || all[2] > frame[2] || all[1] <= frame[1] || all[3] >= frame[3])
      return false
    for (let row = 1; row < table.grid.length; row++) {
      const rowFonts = Array.from({ length: columns }, (_, col) => fonts(at(row, col)))
      if (
        rowFonts.some((ff) => !ff.length || ff.some((f) => !below(f))) ||
        !sameBaseline(rowFonts.flat()) ||
        rowFonts
          .flat()
          .some(
            (f) =>
              f.baseline <=
              Math.max(...top.flatMap((ff) => ff.filter(below)).map((f) => f.baseline))
          )
      )
        return false
    }
    return retained()
  } catch {
    return false
  }
}
function nativeHeaderFirstSourceConflict(table, inventory, rules, context) {
  try {
    const t = nativeRecoveryOwnValues(table),
      c = nativeRecoveryOwnValues(context),
      raw = c?.sourceContent,
      page = c?.sourcePage?.pageNumber,
      v = c?.viewport,
      native = c?.nativeGlyphContext
    if (
      !t ||
      !c ||
      t.parts ||
      !rect(t.cropRect) ||
      !Array.isArray(t.grid) ||
      t.grid.length < 2 ||
      !Array.isArray(t.cells) ||
      !Array.isArray(inventory) ||
      !Array.isArray(rules) ||
      !raw?.items ||
      c.content !== raw ||
      !native?.content?.items ||
      native.content.items.length !== raw.items.length ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !(v?.scale > 0) ||
      v.rotation !== 0 ||
      native.viewport?.rotation !== 0 ||
      native.viewport.scale !== 1 ||
      t.page !== page ||
      c.sourcePage.width !== native.viewport.width ||
      c.sourcePage.height !== native.viewport.height ||
      c.sourcePage.invalidGraphicsBounds !== 0 ||
      v.width !== native.viewport.width * v.scale ||
      v.height !== native.viewport.height * v.scale ||
      !sameNumbers(native.viewport.transform, [1, 0, 0, -1, 0, native.viewport.height]) ||
      !sameNumbers(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height])
    )
      return false
    const retained = retainNativeRecoveryInputs(
      [table, inventory, rules, raw, c.sourcePage, native.content, v, native.viewport],
      v,
      native.viewport
    )
    if (!retained) return false
    const forward = new Map(),
      backward = new Map()
    for (const [index, n] of native.content.items.entries()) {
      const r = raw.items[index],
        ns = native.content.styles?.[n.fontName],
        rs = raw.styles?.[r?.fontName]
      if (
        !r ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => n[k] !== r[k]) ||
        !sameNumbers(n.transform, r.transform) ||
        JSON.stringify(ns) !== JSON.stringify(rs) ||
        ns?.vertical !== false ||
        !Number.isFinite(ns.ascent) ||
        !Number.isFinite(ns.descent) ||
        ns.descent > 0 ||
        (forward.has(n.fontName) && forward.get(n.fontName) !== r.fontName) ||
        (backward.has(r.fontName) && backward.get(r.fontName) !== n.fontName) ||
        (r.str?.trim() &&
          (r.sourceItem?.pageNumber !== page ||
            r.sourceItem.index !== index ||
            r.sourceItem.text !== n.str))
      )
        return false
      forward.set(n.fontName, r.fontName)
      backward.set(r.fontName, n.fontName)
    }
    const columns = t.grid[0]?.length
    if (!(columns >= 2) || t.grid.some((r) => !Array.isArray(r) || r.length !== columns))
      return false
    const slots = new Set(),
      selected = [],
      owners = new Map()
    for (const cell of t.cells) {
      if (
        ![cell.row, cell.column, cell.rowSpan, cell.colSpan].every(Number.isSafeInteger) ||
        cell.row < 0 ||
        cell.column < 0 ||
        cell.rowSpan < 1 ||
        cell.colSpan < 1 ||
        cell.row + cell.rowSpan > t.grid.length ||
        cell.column + cell.colSpan > columns ||
        cell.sourceSegments?.length ||
        !Array.isArray(cell.sourceRects) ||
        !Array.isArray(cell.sourceItems ?? []) ||
        cell.sourceRects.length !== (cell.sourceItems?.length ?? 0) ||
        t.grid[cell.row]?.[cell.column] !== cell.text ||
        !!cell.text.trim() !== !!cell.sourceItems?.length
      )
        return false
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
        for (let col = cell.column; col < cell.column + cell.colSpan; col++) {
          const slot = r + ':' + col
          if (slots.has(slot)) return false
          slots.add(slot)
        }
      const remaining = [...cell.sourceRects]
      for (const origin of cell.sourceItems ?? []) {
        const fonts = inventory.filter((f) => f.sourceItem && key(f.sourceItem) === key(origin)),
          item = raw.items[origin.index],
          original = native.content.items[origin.index]
        if (
          owners.has(key(origin)) ||
          origin.pageNumber !== page ||
          fonts.length !== 1 ||
          item?.str !== origin.text ||
          original?.str !== origin.text ||
          backward.get(item.fontName) !== original.fontName ||
          item.width !== original.width ||
          item.height !== original.height ||
          item.dir !== original.dir ||
          item.hasEOL !== original.hasEOL ||
          !Array.isArray(item.transform) ||
          item.transform.length !== 6 ||
          item.transform.some((z, i) => z !== original.transform?.[i]) ||
          !item.transform.every(Number.isFinite) ||
          !(item.transform[0] > 0) ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          !(item.transform[3] > 0)
        )
          return false
        const font = fonts[0],
          style = raw.styles?.[item.fontName],
          ns = native.content.styles?.[original.fontName],
          canonical = tableTextToken(item, v, 0),
          matches = remaining.filter(
            (r) => rect(r) && r.every((z, i) => Math.abs(z - font.rect[i]) < 1e-6)
          )
        if (
          !style ||
          !ns ||
          style.vertical !== false ||
          ns.vertical !== false ||
          !Number.isFinite(style.ascent) ||
          !(style.ascent > 0) ||
          !Number.isFinite(style.descent) ||
          style.ascent !== ns.ascent ||
          style.descent !== ns.descent ||
          matches.length !== 1 ||
          !canonical.horizontal ||
          !rect(canonical.rect) ||
          canonical.rect[0] >= canonical.rect[2] ||
          canonical.rect[1] >= canonical.rect[3] ||
          !Number.isFinite(font.height) ||
          !Number.isFinite(font.baseline) ||
          Math.abs(canonical.height - font.height) > 1e-6 ||
          Math.abs(canonical.baseline - font.baseline) > 1e-6 ||
          canonical.rect.some((z, i) => Math.abs(z - font.rect[i]) > 1e-6)
        )
          return false
        remaining.splice(remaining.indexOf(matches[0]), 1)
        selected.push(font)
        owners.set(key(origin), cell)
      }
      if (remaining.length) return false
    }
    if (!proveNativeUniqueWholeFonts(selected, inventory)) return false
    if (
      inventory.some(
        (f) => f.text?.trim() && (!rect(f.rect) || f.rect[0] >= f.rect[2] || f.rect[1] >= f.rect[3])
      )
    )
      return false
    return nativeHeaderFirstRecordConflict(t, selected, owners, inventory, rules, c) && retained()
  } catch {
    return false
  }
}

// A fully painted column divider cannot run through one non-spanning owner
// on several independent rows. A repeated folio alone is not a table body.
// Both witnesses only request the existing conservative mapping fallback.
function nativeSparseOrDividedRecordConflict(table, selected, owners, inventory, rules, context) {
  try {
    const native = context.nativeGlyphContext,
      page = context.sourcePage,
      v = native.viewport,
      scale = context.viewport.scale,
      retained = retainNativeRecoveryInputs(
        [
          table,
          inventory,
          rules,
          context.sourceContent,
          page,
          native.content,
          native.operators,
          native.glyphBounds,
          native.graphicsBounds,
          native.skippedSpaceGlyphs,
          context.viewport,
          v,
          context.nativeFolioPages
        ],
        context.viewport,
        v
      )
    if (
      !retained ||
      native.pageNumber !== table.page ||
      JSON.stringify(page.graphicsBounds) !== JSON.stringify(native.graphicsBounds)
    )
      return false
    const content = {
        ...native.content,
        items: context.sourceContent.items.map((r, i) => ({
          ...r,
          fontName: native.content.items[i].fontName
        }))
      },
      viewport = { ...v, convertToViewportPoint: (x, y) => [x, v.height - y] },
      tokens = content.items
        .filter((r) => r.str?.trim())
        .map((r) => tableTextToken(r, viewport, 0)),
      packet = nativePageTextPacketInventory(page, tokens, { ...native, content, viewport }, true)
    if (!packet) return false
    const records = new Map()
    for (const f of selected) {
      const found = packet.records.filter(
        (r) =>
          r.index === f.sourceItem.index &&
          r.r.str === f.text &&
          r.rect.every((x, i) => Math.abs(x * scale - f.rect[i]) < 1e-6)
      )
      if (found.length !== 1) return false
      records.set(f, found[0])
    }
    const valid = (r) => rect(r) && r[0] < r[2] && r[1] < r[3],
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      ink = (r) => {
        const rs = r.part.map((p) => p.g.ink)
        return [
          Math.min(...rs.map((r) => r[0])),
          Math.min(...rs.map((r) => r[1])),
          Math.max(...rs.map((r) => r[2])),
          Math.max(...rs.map((r) => r[3]))
        ]
      },
      crop = table.cropRect.map((z) => z / scale)
    if (packet.records.some((r) => !valid(r.rect) || r.part.some((p) => !valid(p.g.ink))))
      return false
    if (selected.length === 1) {
      const f = selected[0],
        r = records.get(f),
        n = r.r,
        peers = context.nativeFolioPages,
        cell = owners.get(key(f.sourceItem)),
        h = f.height / scale
      if (
        table.grid.length < 4 ||
        table.grid[0].length < 2 ||
        table.cells.some(
          (c) => c !== cell && (c.text.trim() || c.sourceItems?.length || c.sourceSegments?.length)
        ) ||
        f.text !== String(table.page) ||
        cell.sourceItems.length !== 1 ||
        cell.sourceSegments?.length ||
        r.rect[1] <= v.height * 0.85 ||
        Math.abs((r.rect[0] + r.rect[2] - v.width) / 2) >= h * 0.05 ||
        r.rect[3] >= v.height ||
        packet.evidence.paths.size ||
        packet.evidence.images.length ||
        !Array.isArray(peers) ||
        packet.records.some(
          (q) =>
            q !== r &&
            (q.rect[3] >= r.rect[1] - h ||
              hit(q.rect, crop) ||
              q.part.some((p) => hit(p.g.ink, crop)))
        )
      )
        return false
      const repeated = peers.filter((p) => {
        if (
          p.pageNumber === table.page ||
          !Number.isSafeInteger(p.pageNumber) ||
          p.pageNumber < 1 ||
          p.width !== v.width ||
          p.height !== v.height ||
          !Array.isArray(p.lines) ||
          p.lines.some(
            (l) =>
              typeof l.text !== 'string' ||
              ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
              l.width <= 0 ||
              l.height <= 0 ||
              l.fontSize <= 0
          )
        )
          return false
        const folios = p.lines.filter((l) => l.text === String(p.pageNumber))
        if (folios.length !== 1) return false
        const a = folios[0]
        return (
          Math.abs(a.y - r.rect[1]) < 1e-5 &&
          Math.abs(a.height - h) < 1e-5 &&
          Math.abs(a.fontSize - n.height) < 1e-5 &&
          Math.abs(a.x + a.width / 2 - (r.rect[0] + r.rect[2]) / 2) < 1e-5 &&
          p.lines.every((l) => l === a || l.y + l.height < a.y)
        )
      })
      return new Set(repeated.map((p) => p.pageNumber)).size >= 2 && retained()
    }
    if (
      table.grid[0].length !== 2 ||
      table.grid.length < 3 ||
      table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1)
    )
      return false
    const paintMap = new Map(),
      nativeRules = collectTableRules(native.operators, viewport, paintMap),
      identity = native.graphicsBounds.map((g) => ({
        kind: g.kind,
        operationIndex: g.operationIndex,
        rect: g.normalizedRect.map((x, i) => x * (i % 2 ? v.height : v.width))
      })),
      precise = preciseNativeGraphicsBounds({
        nativeGlyphContext: native,
        viewport,
        rulePaintBounds: paintMap,
        nativeEvidenceGraphics: identity,
        nativePaintIdentityGraphics: identity
      })
    if (
      precise.length !== identity.length ||
      precise.some((r) => !valid(r)) ||
      nativeRules.length !== rules.length ||
      rules.some(
        (r) =>
          !nativeRules.some((n) =>
            sameNumbers(
              n.map((z) => z * scale),
              r
            )
          )
      )
    )
      return false
    const colorAt = (i) => {
        let color = '#000000'
        const stack = []
        for (let k = 0; k < i; k++) {
          const op = native.operators.fnArray[k],
            a = native.operators.argsArray[k]
          if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ op, color })
          else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
            const s = stack.pop()
            if (!s || s.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
            color = s.color
          } else if (op === OPS.setStrokeRGBColor) color = a?.[0]
          else if (
            [
              OPS.setStrokeGray,
              OPS.setStrokeCMYKColor,
              OPS.setStrokeColor,
              OPS.setStrokeColorN
            ].includes(op)
          )
            return
        }
        return typeof color === 'string' &&
          /^#[a-f0-9]{6}$/iu.test(color) &&
          color.toLowerCase() !== '#ffffff'
          ? color
          : undefined
      },
      visible = []
    for (const [op, state] of packet.evidence.paths) {
      const a = native.operators.argsArray[op],
        q = Array.from(a?.[1]?.[0] ?? []),
        g = identity.findIndex((g) => g.operationIndex === op)
      if (
        g < 0 ||
        identity[g].kind !== 'path' ||
        native.operators.fnArray[op] !== OPS.constructPath ||
        a?.[0] !== OPS.stroke ||
        a?.[1]?.length !== 1 ||
        q.length !== 6 ||
        !q.every(Number.isFinite) ||
        q[0] !== 0 ||
        q[3] !== 1 ||
        q[1] !== q[4] ||
        q[2] === q[5] ||
        state.lineCap !== 0 ||
        state.strokeAlpha !== 1 ||
        state.solidStroke !== true ||
        !(state.lineWidth > 0) ||
        !Number.isFinite(state.lineWidth) ||
        !sameNumbers(state.transform.slice(0, 4), [1, 0, 0, 1]) ||
        !sameNumbers(state.clip, [0, 0, v.width, v.height])
      )
        continue
      if (!colorAt(op)) continue
      const x = q[1] + state.transform[4],
        lo = v.height - Math.max(q[2], q[5]) - state.transform[5],
        hi = v.height - Math.min(q[2], q[5]) - state.transform[5],
        expected = [x - state.lineWidth / 2, lo, x + state.lineWidth / 2, hi],
        paint = precise[g]
      if (
        !sameNumbers(expected, paint) ||
        !nativeRules.some((r) => sameNumbers(r, [x, lo, x, hi])) ||
        precise.some((r, i) => i !== g && hit(r, paint)) ||
        packet.glyphs.some((g) => hit(g.ink, paint))
      )
        continue
      visible.push({ x, lo, hi, paint })
    }
    const xs = [...new Set(visible.map((r) => r.x))],
      plans = []
    for (const x of xs) {
      if (x <= crop[0] || x >= crop[2]) continue
      const crossed = []
      for (let row = 0; row < table.grid.length; row++) {
        const c = table.cells.find((c) => c.row === row && c.column === 0),
          rightCell = table.cells.find((c) => c.row === row && c.column === 1)
        if (!c || !rightCell) continue
        const list = selected
            .filter((f) => owners.get(key(f.sourceItem)) === c)
            .map((f) => records.get(f)),
          right = selected
            .filter((f) => owners.get(key(f.sourceItem)) === rightCell)
            .map((f) => records.get(f)),
          left = list.filter((r) => ink(r)[2] < x),
          over = list.filter((r) => ink(r)[0] > x)
        if (!left.length || !over.length || !right.length || right.some((r) => ink(r)[0] <= x))
          continue
        if (
          !left.some((l) =>
            over.some((r) => Math.max(ink(l)[1], ink(r)[1]) < Math.min(ink(l)[3], ink(r)[3]))
          )
        )
          continue
        const bounds = box([...list, ...right].map((r) => ({ rect: ink(r) })))
        if (row === 0 || visible.some((r) => r.x === x && r.lo <= bounds[1] && r.hi >= bounds[3]))
          crossed.push(row)
      }
      if (crossed.includes(0) && crossed.filter((r) => r > 0).length >= 2) plans.push(x)
    }
    return plans.length === 1 && retained()
  } catch {
    return false
  }
}

function nativeSparseOrDividedSourceConflict(table, inventory, rules, context) {
  try {
    const t = nativeRecoveryOwnValues(table),
      c = nativeRecoveryOwnValues(context),
      raw = c?.sourceContent,
      page = c?.sourcePage?.pageNumber,
      v = c?.viewport,
      native = c?.nativeGlyphContext
    if (
      !t ||
      !c ||
      t.parts ||
      !rect(t.cropRect) ||
      !Array.isArray(t.grid) ||
      t.grid.length < 2 ||
      !Array.isArray(t.cells) ||
      !Array.isArray(inventory) ||
      !Array.isArray(rules) ||
      !raw?.items ||
      c.content !== raw ||
      !native?.content?.items ||
      native.content.items.length !== raw.items.length ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !(v?.scale > 0) ||
      v.rotation !== 0 ||
      native.viewport?.rotation !== 0 ||
      native.viewport.scale !== 1 ||
      t.page !== page ||
      c.sourcePage.width !== native.viewport.width ||
      c.sourcePage.height !== native.viewport.height ||
      c.sourcePage.invalidGraphicsBounds !== 0 ||
      v.width !== native.viewport.width * v.scale ||
      v.height !== native.viewport.height * v.scale ||
      !sameNumbers(native.viewport.transform, [1, 0, 0, -1, 0, native.viewport.height]) ||
      !sameNumbers(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height])
    )
      return false
    const nonempty = t.cells.filter((c) => c.text?.trim())
    if (
      !(t.grid.length >= 4 && nonempty.length === 1) &&
      !(
        t.grid[0]?.length === 2 &&
        t.grid.length >= 3 &&
        t.cells.some((c) => c.row === 0 && c.column === 0 && c.sourceItems?.length >= 2)
      )
    )
      return false
    const retained = retainNativeRecoveryInputs(
      [table, inventory, rules, raw, c.sourcePage, native.content, v, native.viewport],
      v,
      native.viewport
    )
    if (!retained) return false
    const forward = new Map(),
      backward = new Map()
    for (const [index, n] of native.content.items.entries()) {
      const r = raw.items[index],
        ns = native.content.styles?.[n.fontName],
        rs = raw.styles?.[r?.fontName]
      if (
        !r ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => n[k] !== r[k]) ||
        !sameNumbers(n.transform, r.transform) ||
        JSON.stringify(ns) !== JSON.stringify(rs) ||
        ns?.vertical !== false ||
        !Number.isFinite(ns.ascent) ||
        !Number.isFinite(ns.descent) ||
        ns.descent > 0 ||
        (forward.has(n.fontName) && forward.get(n.fontName) !== r.fontName) ||
        (backward.has(r.fontName) && backward.get(r.fontName) !== n.fontName) ||
        (r.str?.trim() &&
          (r.sourceItem?.pageNumber !== page ||
            r.sourceItem.index !== index ||
            r.sourceItem.text !== n.str))
      )
        return false
      forward.set(n.fontName, r.fontName)
      backward.set(r.fontName, n.fontName)
    }
    const columns = t.grid[0]?.length
    if (!(columns >= 2) || t.grid.some((r) => !Array.isArray(r) || r.length !== columns))
      return false
    const slots = new Set(),
      selected = [],
      owners = new Map()
    for (const cell of t.cells) {
      if (
        ![cell.row, cell.column, cell.rowSpan, cell.colSpan].every(Number.isSafeInteger) ||
        cell.row < 0 ||
        cell.column < 0 ||
        cell.rowSpan < 1 ||
        cell.colSpan < 1 ||
        cell.row + cell.rowSpan > t.grid.length ||
        cell.column + cell.colSpan > columns ||
        cell.sourceSegments?.length ||
        !Array.isArray(cell.sourceRects) ||
        !Array.isArray(cell.sourceItems ?? []) ||
        cell.sourceRects.length !== (cell.sourceItems?.length ?? 0) ||
        t.grid[cell.row]?.[cell.column] !== cell.text ||
        !!cell.text.trim() !== !!cell.sourceItems?.length
      )
        return false
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
        for (let col = cell.column; col < cell.column + cell.colSpan; col++) {
          const slot = r + ':' + col
          if (slots.has(slot)) return false
          slots.add(slot)
        }
      const remaining = [...cell.sourceRects]
      for (const origin of cell.sourceItems ?? []) {
        const fonts = inventory.filter((f) => f.sourceItem && key(f.sourceItem) === key(origin)),
          item = raw.items[origin.index],
          original = native.content.items[origin.index]
        if (
          owners.has(key(origin)) ||
          origin.pageNumber !== page ||
          fonts.length !== 1 ||
          item?.str !== origin.text ||
          original?.str !== origin.text ||
          backward.get(item.fontName) !== original.fontName ||
          item.width !== original.width ||
          item.height !== original.height ||
          item.dir !== original.dir ||
          item.hasEOL !== original.hasEOL ||
          !Array.isArray(item.transform) ||
          item.transform.length !== 6 ||
          item.transform.some((z, i) => z !== original.transform?.[i]) ||
          !item.transform.every(Number.isFinite) ||
          !(item.transform[0] > 0) ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          !(item.transform[3] > 0)
        )
          return false
        const font = fonts[0],
          style = raw.styles?.[item.fontName],
          ns = native.content.styles?.[original.fontName],
          canonical = tableTextToken(item, v, 0),
          matches = remaining.filter(
            (r) => rect(r) && r.every((z, i) => Math.abs(z - font.rect[i]) < 1e-6)
          )
        if (
          !style ||
          !ns ||
          style.vertical !== false ||
          ns.vertical !== false ||
          !Number.isFinite(style.ascent) ||
          !(style.ascent > 0) ||
          !Number.isFinite(style.descent) ||
          style.ascent !== ns.ascent ||
          style.descent !== ns.descent ||
          matches.length !== 1 ||
          !canonical.horizontal ||
          !rect(canonical.rect) ||
          canonical.rect[0] >= canonical.rect[2] ||
          canonical.rect[1] >= canonical.rect[3] ||
          !Number.isFinite(font.height) ||
          !Number.isFinite(font.baseline) ||
          Math.abs(canonical.height - font.height) > 1e-6 ||
          Math.abs(canonical.baseline - font.baseline) > 1e-6 ||
          canonical.rect.some((z, i) => Math.abs(z - font.rect[i]) > 1e-6)
        )
          return false
        remaining.splice(remaining.indexOf(matches[0]), 1)
        selected.push(font)
        owners.set(key(origin), cell)
      }
      if (remaining.length) return false
    }
    if (!proveNativeUniqueWholeFonts(selected, inventory)) return false
    if (
      inventory.some(
        (f) => f.text?.trim() && (!rect(f.rect) || f.rect[0] >= f.rect[2] || f.rect[1] >= f.rect[3])
      )
    )
      return false
    return (
      nativeSparseOrDividedRecordConflict(t, selected, owners, inventory, rules, c) && retained()
    )
  } catch {
    return false
  }
}

function nativeCollapsedSelectedSourceConflict(table, inventory, rules, context) {
  try {
    const t = nativeRecoveryOwnValues(table),
      c = nativeRecoveryOwnValues(context),
      raw = c?.sourceContent,
      page = c?.sourcePage?.pageNumber,
      v = c?.viewport,
      native = c?.nativeGlyphContext
    if (
      !t ||
      !c ||
      t.parts ||
      !rect(t.cropRect) ||
      !Array.isArray(t.grid) ||
      t.grid.length < 2 ||
      !Array.isArray(t.cells) ||
      !Array.isArray(inventory) ||
      !Array.isArray(rules) ||
      !raw?.items ||
      c.content !== raw ||
      !native?.content?.items ||
      native.content.items.length !== raw.items.length ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !(v?.scale > 0) ||
      v.rotation !== 0 ||
      native.viewport?.rotation !== 0 ||
      native.viewport.scale !== 1 ||
      t.page !== page ||
      c.sourcePage.width !== native.viewport.width ||
      c.sourcePage.height !== native.viewport.height ||
      c.sourcePage.invalidGraphicsBounds !== 0 ||
      v.width !== native.viewport.width * v.scale ||
      v.height !== native.viewport.height * v.scale ||
      !sameNumbers(native.viewport.transform, [1, 0, 0, -1, 0, native.viewport.height]) ||
      !sameNumbers(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height])
    )
      return false
    const retained = retainNativeRecoveryInputs(
      [table, inventory, rules, raw, c.sourcePage, native.content, v, native.viewport],
      v,
      native.viewport
    )
    if (!retained) return false
    const forward = new Map(),
      backward = new Map()
    for (const [index, n] of native.content.items.entries()) {
      const r = raw.items[index],
        ns = native.content.styles?.[n.fontName],
        rs = raw.styles?.[r?.fontName]
      if (
        !r ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => n[k] !== r[k]) ||
        !sameNumbers(n.transform, r.transform) ||
        JSON.stringify(ns) !== JSON.stringify(rs) ||
        ns?.vertical !== false ||
        !Number.isFinite(ns.ascent) ||
        !Number.isFinite(ns.descent) ||
        ns.descent > 0 ||
        (forward.has(n.fontName) && forward.get(n.fontName) !== r.fontName) ||
        (backward.has(r.fontName) && backward.get(r.fontName) !== n.fontName) ||
        (r.str?.trim() &&
          (r.sourceItem?.pageNumber !== page ||
            r.sourceItem.index !== index ||
            r.sourceItem.text !== n.str))
      )
        return false
      forward.set(n.fontName, r.fontName)
      backward.set(r.fontName, n.fontName)
    }
    const columns = t.grid[0]?.length
    if (!(columns >= 2) || t.grid.some((r) => !Array.isArray(r) || r.length !== columns))
      return false
    const slots = new Set(),
      selected = [],
      owners = new Map(),
      originals = new Map()
    for (const cell of t.cells) {
      if (
        ![cell.row, cell.column, cell.rowSpan, cell.colSpan].every(Number.isSafeInteger) ||
        cell.row < 0 ||
        cell.column < 0 ||
        cell.rowSpan < 1 ||
        cell.colSpan < 1 ||
        cell.row + cell.rowSpan > t.grid.length ||
        cell.column + cell.colSpan > columns ||
        cell.sourceSegments?.length ||
        !Array.isArray(cell.sourceRects) ||
        !Array.isArray(cell.sourceItems ?? []) ||
        cell.sourceRects.length !== (cell.sourceItems?.length ?? 0) ||
        t.grid[cell.row]?.[cell.column] !== cell.text ||
        !!cell.text.trim() !== !!cell.sourceItems?.length
      )
        return false
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
        for (let col = cell.column; col < cell.column + cell.colSpan; col++) {
          const slot = r + ':' + col
          if (slots.has(slot)) return false
          slots.add(slot)
        }
      const remaining = [...cell.sourceRects]
      for (const origin of cell.sourceItems ?? []) {
        const fonts = inventory.filter((f) => f.sourceItem && key(f.sourceItem) === key(origin)),
          item = raw.items[origin.index],
          original = native.content.items[origin.index]
        if (
          owners.has(key(origin)) ||
          origin.pageNumber !== page ||
          fonts.length !== 1 ||
          item?.str !== origin.text ||
          original?.str !== origin.text ||
          backward.get(item.fontName) !== original.fontName ||
          item.width !== original.width ||
          item.height !== original.height ||
          item.dir !== original.dir ||
          item.hasEOL !== original.hasEOL ||
          !Array.isArray(item.transform) ||
          item.transform.length !== 6 ||
          item.transform.some((z, i) => z !== original.transform?.[i]) ||
          !item.transform.every(Number.isFinite) ||
          !(item.transform[0] > 0) ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          !(item.transform[3] > 0)
        )
          return false
        const font = fonts[0],
          style = raw.styles?.[item.fontName],
          ns = native.content.styles?.[original.fontName],
          canonical = tableTextToken(item, v, 0),
          matches = remaining.filter(
            (r) => rect(r) && r.every((z, i) => Math.abs(z - font.rect[i]) < 1e-6)
          )
        if (
          !style ||
          !ns ||
          style.vertical !== false ||
          ns.vertical !== false ||
          !Number.isFinite(style.ascent) ||
          !(style.ascent > 0) ||
          !Number.isFinite(style.descent) ||
          style.ascent !== ns.ascent ||
          style.descent !== ns.descent ||
          matches.length !== 1 ||
          !canonical.horizontal ||
          !rect(canonical.rect) ||
          canonical.rect[0] >= canonical.rect[2] ||
          canonical.rect[1] >= canonical.rect[3] ||
          !Number.isFinite(font.height) ||
          !Number.isFinite(font.baseline) ||
          Math.abs(canonical.height - font.height) > 1e-6 ||
          Math.abs(canonical.baseline - font.baseline) > 1e-6 ||
          canonical.rect.some((z, i) => Math.abs(z - font.rect[i]) > 1e-6)
        )
          return false
        remaining.splice(remaining.indexOf(matches[0]), 1)
        selected.push(font)
        owners.set(key(origin), cell)
        originals.set(origin.index, item)
      }
      if (remaining.length) return false
    }
    if (!proveNativeUniqueWholeFonts(selected, inventory)) return false
    if (
      inventory.some(
        (f) => f.text?.trim() && (!rect(f.rect) || f.rect[0] >= f.rect[2] || f.rect[1] >= f.rect[3])
      )
    )
      return false
    return (
      nativeCollapsedRuledRecordConflict(t, selected, owners, inventory, rules, c) && retained()
    )
  } catch {
    return false
  }
}

function nativeFinalColumnOwnershipConflict(table, inventory, rules, context) {
  try {
    const t = nativeRecoveryOwnValues(table),
      c = nativeRecoveryOwnValues(context),
      raw = c?.sourceContent,
      page = c?.sourcePage?.pageNumber,
      v = c?.viewport,
      native = c?.nativeGlyphContext
    if (
      !t ||
      !c ||
      t.parts ||
      !rect(t.cropRect) ||
      !Array.isArray(t.grid) ||
      t.grid.length < 2 ||
      !Array.isArray(t.cells) ||
      !Array.isArray(inventory) ||
      !Array.isArray(rules) ||
      !raw?.items ||
      c.content !== raw ||
      !native?.content?.items ||
      native.content.items.length !== raw.items.length ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !(v?.scale > 0) ||
      v.rotation !== 0 ||
      native.viewport?.rotation !== 0 ||
      native.viewport.scale !== 1 ||
      t.page !== page ||
      c.sourcePage.width !== native.viewport.width ||
      c.sourcePage.height !== native.viewport.height ||
      c.sourcePage.invalidGraphicsBounds !== 0 ||
      v.width !== native.viewport.width * v.scale ||
      v.height !== native.viewport.height * v.scale ||
      !sameNumbers(native.viewport.transform, [1, 0, 0, -1, 0, native.viewport.height]) ||
      !sameNumbers(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height])
    )
      return false
    const retained = retainNativeRecoveryInputs(
      [table, inventory, rules, raw, c.sourcePage, native.content, v, native.viewport],
      v,
      native.viewport
    )
    if (!retained) return false
    const forward = new Map(),
      backward = new Map()
    for (const [index, n] of native.content.items.entries()) {
      const r = raw.items[index],
        ns = native.content.styles?.[n.fontName],
        rs = raw.styles?.[r?.fontName]
      if (
        !r ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => n[k] !== r[k]) ||
        !sameNumbers(n.transform, r.transform) ||
        JSON.stringify(ns) !== JSON.stringify(rs) ||
        ns?.vertical !== false ||
        !(ns.ascent > 0) ||
        !Number.isFinite(ns.ascent) ||
        !Number.isFinite(ns.descent) ||
        ns.descent > 0 ||
        (forward.has(n.fontName) && forward.get(n.fontName) !== r.fontName) ||
        (backward.has(r.fontName) && backward.get(r.fontName) !== n.fontName) ||
        (r.str?.trim() &&
          (r.sourceItem?.pageNumber !== page ||
            r.sourceItem.index !== index ||
            r.sourceItem.text !== n.str))
      )
        return false
      forward.set(n.fontName, r.fontName)
      backward.set(r.fontName, n.fontName)
    }
    const columns = t.grid[0]?.length
    if (!(columns >= 2) || t.grid.some((r) => !Array.isArray(r) || r.length !== columns))
      return false
    const slots = new Set(),
      selected = [],
      owners = new Map(),
      originals = new Map()
    for (const cell of t.cells) {
      if (
        ![cell.row, cell.column, cell.rowSpan, cell.colSpan].every(Number.isSafeInteger) ||
        cell.row < 0 ||
        cell.column < 0 ||
        cell.rowSpan < 1 ||
        cell.colSpan < 1 ||
        cell.row + cell.rowSpan > t.grid.length ||
        cell.column + cell.colSpan > columns ||
        cell.sourceSegments?.length ||
        !Array.isArray(cell.sourceRects) ||
        !Array.isArray(cell.sourceItems ?? []) ||
        cell.sourceRects.length !== (cell.sourceItems?.length ?? 0) ||
        t.grid[cell.row]?.[cell.column] !== cell.text ||
        !!cell.text.trim() !== !!cell.sourceItems?.length
      )
        return false
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
        for (let col = cell.column; col < cell.column + cell.colSpan; col++) {
          const slot = r + ':' + col
          if (slots.has(slot)) return false
          slots.add(slot)
        }
      const remaining = [...cell.sourceRects]
      for (const origin of cell.sourceItems ?? []) {
        const fonts = inventory.filter((f) => f.sourceItem && key(f.sourceItem) === key(origin)),
          item = raw.items[origin.index],
          original = native.content.items[origin.index]
        if (
          owners.has(key(origin)) ||
          origin.pageNumber !== page ||
          fonts.length !== 1 ||
          item?.str !== origin.text ||
          original?.str !== origin.text ||
          backward.get(item.fontName) !== original.fontName ||
          item.width !== original.width ||
          item.height !== original.height ||
          item.dir !== original.dir ||
          item.hasEOL !== original.hasEOL ||
          !Array.isArray(item.transform) ||
          item.transform.length !== 6 ||
          item.transform.some((z, i) => z !== original.transform?.[i]) ||
          !item.transform.every(Number.isFinite) ||
          !(item.transform[0] > 0) ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          !(item.transform[3] > 0)
        )
          return false
        const font = fonts[0],
          style = raw.styles?.[item.fontName],
          ns = native.content.styles?.[original.fontName],
          canonical = tableTextToken(item, v, 0),
          matches = remaining.filter(
            (r) => rect(r) && r.every((z, i) => Math.abs(z - font.rect[i]) < 1e-6)
          )
        if (
          !style ||
          !ns ||
          style.vertical !== false ||
          ns.vertical !== false ||
          !Number.isFinite(style.ascent) ||
          !Number.isFinite(style.descent) ||
          style.ascent !== ns.ascent ||
          style.descent !== ns.descent ||
          matches.length !== 1 ||
          !canonical.horizontal ||
          !rect(canonical.rect) ||
          canonical.rect[0] >= canonical.rect[2] ||
          canonical.rect[1] >= canonical.rect[3] ||
          !Number.isFinite(font.height) ||
          !Number.isFinite(font.baseline) ||
          Math.abs(canonical.height - font.height) > 1e-6 ||
          Math.abs(canonical.baseline - font.baseline) > 1e-6 ||
          canonical.rect.some((z, i) => Math.abs(z - font.rect[i]) > 1e-6)
        )
          return false
        remaining.splice(remaining.indexOf(matches[0]), 1)
        selected.push(font)
        owners.set(key(origin), cell)
        originals.set(origin.index, item)
      }
      if (remaining.length) return false
    }
    if (!proveNativeUniqueWholeFonts(selected, inventory)) return false
    const eq = (a, b) => Math.abs(a - b) < 1e-6,
      item = (f) => originals.get(f.sourceItem.index),
      cellFonts = (cell) => selected.filter((f) => owners.get(key(f.sourceItem)) === cell),
      sameLine = (a, b) =>
        a.height > 0 &&
        a.height === b.height &&
        a.transform.slice(0, 4).every((z, i) => z === b.transform[i]) &&
        eq(a.transform[5], b.transform[5]),
      gap = (a, b) => {
        const x = raw.items[a.sourceItem.index + 1],
          aa = item(a),
          bb = item(b)
        return x?.str === ' ' &&
          a.sourceItem.index + 2 === b.sourceItem.index &&
          eq(x.transform[5], aa.transform[5]) &&
          eq(x.transform[4], aa.transform[4] + aa.width) &&
          eq(x.transform[4] + x.width, bb.transform[4])
          ? x
          : null
      },
      clear = (fonts) => {
        const b = box(fonts),
          set = new Set(fonts)
        return (
          !inventory.some(
            (f) =>
              f.text?.trim() &&
              !set.has(f) &&
              rect(f.rect) &&
              f.rect[0] < b[2] &&
              f.rect[2] > b[0] &&
              f.rect[1] < b[3] &&
              f.rect[3] > b[1]
          ) &&
          !rules.some(
            (r) =>
              Array.isArray(r) &&
              r.length === 4 &&
              Math.min(r[0], r[2]) <= b[2] &&
              Math.max(r[0], r[2]) >= b[0] &&
              Math.min(r[1], r[3]) <= b[3] &&
              Math.max(r[1], r[3]) >= b[1]
          )
        )
      },
      tailRow = t.grid.length - 1,
      tail = t.cells.filter((f) => f.row === tailRow),
      at = (r, col) => t.cells.find((f) => f.row === r && f.column === col)
    if (nativeFlowPartitionConflict(t, selected, owners, originals, inventory, rules, c))
      return retained()
    if (
      inventory.some(
        (f) => f.text?.trim() && (!rect(f.rect) || f.rect[0] >= f.rect[2] || f.rect[1] >= f.rect[3])
      )
    )
      return false
    // Repeated independent right-field leads close the lane; the last interval
    // must include its original explicit spaces, not just balanced punctuation.
    if (columns === 2 && t.grid.length >= 5) {
      const left = cellFonts(at(tailRow, 0)),
        right = cellFonts(at(tailRow, 1)),
        a = left.at(-2),
        comma = left.at(-1),
        end = right[0],
        formula = right[1]
      if (
        a &&
        comma &&
        end &&
        formula &&
        /^[[(][+-]?\d+(?:\.\d+)?$/u.test(a.text) &&
        comma.text === ',' &&
        /^[+-]?\d+(?:\.\d+)?[\])]$/u.test(end.text) &&
        /^[≤≥=<>]/u.test(formula.text) &&
        sameLine(item(a), item(end)) &&
        sameLine(item(comma), item(end)) &&
        item(a).fontName === item(end).fontName &&
        a.sourceItem.index + 1 === comma.sourceItem.index &&
        eq(item(a).transform[4] + item(a).width, item(comma).transform[4])
      ) {
        const inner = gap(comma, end),
          outer = gap(end, formula),
          peers = t.cells
            .filter((f) => f.column === 1 && f.row > 0 && f.row < tailRow)
            .map((f) => cellFonts(f)[0]),
          stubs = t.cells.filter((f) => f.column === 0 && f.row > 0).map((f) => cellFonts(f)[0])
        if (
          inner &&
          outer &&
          outer.width > item(a).height &&
          outer.width > inner.width * 8 &&
          peers.length >= 3 &&
          peers.every((f) => f && Math.abs(f.rect[0] - formula.rect[0]) < f.height * 0.001) &&
          stubs.length >= 4 &&
          stubs.every((f) => f && Math.abs(f.rect[0] - stubs[0].rect[0]) < f.height * 0.001) &&
          end.rect[2] < Math.min(...peers.map((f) => f.rect[0])) &&
          clear([...left, end])
        )
          return retained()
      }
    }
    // A decimal's two original advances touch exactly in a separate, rail-bound
    // spanning footer. Do not invent a merged footer or an accent projection.
    if (columns >= 3 && t.grid.length >= 3)
      for (const leftCell of tail) {
        const rightCell = at(tailRow, leftCell.column + 1)
        if (
          !rightCell ||
          leftCell.rowSpan !== 1 ||
          leftCell.colSpan !== 1 ||
          rightCell.rowSpan !== 1 ||
          rightCell.colSpan !== 1
        )
          continue
        const left = cellFonts(leftCell),
          right = cellFonts(rightCell),
          a = left.at(-2),
          dot = left.at(-1),
          end = right[0]
        if (
          !a ||
          !dot ||
          right.length !== 1 ||
          !/\d$/u.test(a.text) ||
          dot.text !== '.' ||
          !/^\d+$/u.test(end.text) ||
          !sameLine(item(a), item(dot)) ||
          !sameLine(item(dot), item(end)) ||
          item(a).fontName !== item(end).fontName ||
          a.sourceItem.index + 1 !== dot.sourceItem.index ||
          dot.sourceItem.index + 1 !== end.sourceItem.index ||
          !eq(item(a).transform[4] + item(a).width, item(dot).transform[4]) ||
          !eq(item(dot).transform[4] + item(dot).width, item(end).transform[4])
        )
          continue
        const fonts = tail.flatMap(cellFonts),
          b = box(fonts),
          hs = rules
            .filter((r) => r[1] === r[3] && r[0] <= b[0] && r[2] >= b[2])
            .sort((a, b) => a[1] - b[1]),
          top = hs.filter((r) => r[1] < b[1]).at(-1),
          bottom = hs.find((r) => r[1] > b[3])
        if (
          top &&
          bottom &&
          cellFonts(at(tailRow, 0)).some((f) => /\p{L}{3}/u.test(f.text)) &&
          !rules.some((r) => r[0] === r[2] && r[1] < bottom[1] && r[3] > top[1]) &&
          !inventory.some(
            (f) =>
              f.text?.trim() &&
              !fonts.includes(f) &&
              rect(f.rect) &&
              f.rect[0] < b[2] &&
              f.rect[2] > b[0] &&
              f.rect[1] < b[3] &&
              f.rect[3] > b[1]
          )
        )
          return retained()
      }
    if (t.caption || t.grid.length !== 2) return false
    const label = at(1, 0)
    if (
      !label ||
      !/^\(\d+(?:\.\d+)*\)$/u.test(label.text.trim()) ||
      !t.cells.some((f) => f.row === 1 && f.column > 0 && /[=≤≥]/u.test(f.text))
    )
      return false
    for (const leftCell of t.cells.filter((f) => f.row === 0)) {
      const left = cellFonts(leftCell),
        rightCell = at(0, leftCell.column + 1),
        right = rightCell && cellFonts(rightCell)
      if (!right?.length) continue
      if (left.length === 2 && right.length === 1) {
        const [a, end] = left,
          b = right[0],
          aa = item(a),
          bb = item(b),
          cc = item(end),
          space = gap(a, b)
        if (
          a.sourceItem.index < b.sourceItem.index &&
          b.sourceItem.index < end.sourceItem.index &&
          space &&
          aa.fontName === bb.fontName &&
          aa.fontName === cc.fontName &&
          sameLine(aa, bb) &&
          aa.height === cc.height &&
          eq(aa.transform[4], cc.transform[4]) &&
          aa.transform[5] - cc.transform[5] > aa.height &&
          aa.transform[5] - cc.transform[5] < aa.height * 2 &&
          [a, b, end].every((f) => /\p{L}{3}/u.test(f.text)) &&
          clear([a, b, end])
        )
          return retained()
      }
      if (left.length !== 1 || !/^\p{L}$/u.test(left[0].text)) continue
      const base = left[0],
        a = item(base),
        supers = right.filter(
          (f) => item(f).height < a.height && item(f).transform[5] > a.transform[5]
        ),
        subs = right.filter(
          (f) => item(f).height < a.height && item(f).transform[5] < a.transform[5]
        )
      for (const upper of supers)
        for (const lower of subs) {
          const u = item(upper),
            l = item(lower)
          if (
            u.height === l.height &&
            u.height > a.height * 0.6 &&
            u.height < a.height * 0.8 &&
            Math.abs(a.transform[4] + a.width - l.transform[4]) < a.height * 0.001 &&
            Math.abs(u.transform[4] - l.transform[4]) < a.height * 0.1 &&
            right.some(
              (f) =>
                /[=≤≥]/u.test(f.text) &&
                item(f).height === a.height &&
                f.rect[0] > lower.rect[0] &&
                f.rect[0] - lower.rect[2] < base.height * 2
            ) &&
            clear([base, upper, lower])
          )
            return retained()
        }
    }
    return false
  } catch {
    return false
  }
}

// Run after measured source segments have been attached: a legitimate measured
// split must not be mistaken for an unsupported partial native owner.
// These witnesses only decline unreliable cell mappings. They never supply a
// replacement grid, a content role, or authority to expand a printed crop.
// This negative witness reuses the complete native packet and its retained
// Source/paint epoch. It never produces cells, mathematical text, or crop bounds.
function nativeBoundedPartitionConflict(table, scope) {
  const { records, used, groups, visible, paintMap, scale } = scope,
    eq = (a, b) => Math.abs(a - b) < 1e-6,
    union = (rs) => [
      Math.min(...rs.map((r) => r[0])),
      Math.min(...rs.map((r) => r[1])),
      Math.max(...rs.map((r) => r[2])),
      Math.max(...rs.map((r) => r[3]))
    ],
    inside = (r, b) => r[0] >= b[0] && r[2] <= b[2] && r[1] >= b[1] && r[3] <= b[3],
    overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    cellRecords = (c) => (c.sourceItems ?? []).map((o) => records.get(o.index)),
    pairwiseSeparate = (runs) => {
      const sorted = [...runs].sort((a, b) => a.bounds[0] - b.bounds[0])
      return sorted.slice(1).every((r, i) => sorted[i].bounds[2] < r.bounds[0])
    }
  const framePaintIndices = (rails) => {
      const indices = new Set()
      for (const rail of rails) {
        const paint = paintMap.get(rail.join(',')),
          matches = scope.identity
            .map((g, i) => ({ g, i }))
            .filter(({ g, i }) => g.kind === 'path' && sameNumbers(scope.precise[i], paint))
        if (matches.length !== 1 || indices.has(matches[0].i)) return
        indices.add(matches[0].i)
      }
      return indices
    },
    obstructed = (bounds, frame) =>
      scope.precise.some((paint, i) => {
        if (frame.has(i)) return false
        const p = paint.map((z) => z / scale)
        if (!overlap(p, bounds)) return false
        // A complete cross-run partition is foreign authority. Small local
        // fraction/radical paint cannot be mistaken for a complete divider.
        return (p[0] <= bounds[0] && p[2] >= bounds[2]) || (p[1] <= bounds[1] && p[3] >= bounds[3])
      })
  const fourRails = groups.filter((g) => g.length === 4 && visible(g))
  if (fourRails.length === 1) {
    const rails = [...fourRails[0]].sort((a, b) => a[1] - b[1]),
      above = paintMap.get(rails[1].join(',')),
      below = paintMap.get(rails[2].join(',')),
      band = [rails[0][0], above[3], rails[0][2], below[1]].map((z) => z / scale),
      pairs = [],
      frame = framePaintIndices(rails)
    if (!frame) return false
    for (const cell of table.cells) {
      if (cell.rowSpan !== 1 || cell.colSpan !== 1 || !cell.sourceItems?.length) continue
      const next = table.cells.find(
        (c) =>
          c.row === cell.row + 1 &&
          c.column === cell.column &&
          c.rowSpan === 1 &&
          c.colSpan === 1 &&
          c.sourceItems?.length
      )
      if (!next) continue
      const a = cellRecords(cell),
        b = cellRecords(next),
        opening = a.filter((r) => r.original.str === '{'),
        closing = b.filter((r) => r.original.str === '}')
      if (
        opening.length !== 1 ||
        closing.length !== 1 ||
        a.some((r) => r.original.str.includes('}')) ||
        b.some((r) => r.original.str.includes('{'))
      )
        continue
      const first = opening[0].original,
        last = closing[0].original,
        all = [...a, ...b],
        bounds = union(all.map((r) => r.envelope)),
        brackets = all
          .flatMap((r) => Array.from(r.original.str))
          .filter((s) => s === '{' || s === '}')
      if (
        brackets.join('') !== '{}' ||
        first.fontName !== last.fontName ||
        first.height !== last.height ||
        !sameNumbers(first.transform.slice(0, 4), last.transform.slice(0, 4)) ||
        !(first.transform[5] > last.transform[5]) ||
        !inside(bounds, band)
      )
        continue
      if (
        !all.some(
          (r) => r.original.height < first.height * 0.8 && r.original.height > first.height * 0.5
        )
      )
        continue
      if (
        scope.rules.some((rule) => {
          if (
            rails.includes(rule) ||
            rule[1] !== rule[3] ||
            rule[0] / scale > bounds[0] ||
            rule[2] / scale < bounds[2]
          )
            return false
          const paint = paintMap.get(rule.join(','))
          // Unknown or complete separator paint cannot be waived by the frame.
          if (!rect(paint) || paint[0] >= paint[2] || paint[1] >= paint[3]) return true
          return (
            paint[3] / scale > opening[0].advance[3] && paint[1] / scale < closing[0].advance[3]
          )
        })
      )
        continue
      if (obstructed(bounds, frame)) continue
      const identities = new Set(all.map((r) => r.packet.index))
      if (
        [...records.values()].some(
          (r) => !identities.has(r.packet.index) && overlap(r.envelope, bounds)
        )
      )
        continue
      pairs.push({
        row: cell.row,
        column: cell.column,
        openingBaseline: first.transform[5],
        closingBaseline: last.transform[5],
        bounds
      })
    }
    for (const a of pairs) {
      const parallel = pairs.filter(
        (b) =>
          b.row === a.row &&
          eq(b.openingBaseline, a.openingBaseline) &&
          eq(b.closingBaseline, a.closingBaseline)
      )
      if (parallel.length < 2 || !pairwiseSeparate(parallel)) continue
      const firstColumn = Math.min(...parallel.map((r) => r.column)),
        leading = table.cells.filter((c) => c.row === a.row + 1 && c.column < firstColumn)
      if (leading.length && leading.every((c) => !c.text.trim() && !c.sourceItems?.length))
        return true
    }
  }
  const threeRails = groups.filter((g) => g.length === 3 && visible(g))
  if (threeRails.length !== 1) return false
  const rails = [...threeRails[0]].sort((a, b) => a[1] - b[1]),
    top = paintMap.get(rails[0].join(',')),
    divider = paintMap.get(rails[1].join(',')),
    bottom = paintMap.get(rails[2].join(',')),
    band = [rails[0][0], top[3], rails[0][2], divider[1]].map((z) => z / scale),
    body = [rails[0][0], divider[3], rails[0][2], bottom[1]].map((z) => z / scale),
    crossings = [],
    frame = framePaintIndices(rails)
  if (!frame) return false
  for (const record of records.values()) {
    if (record.original.str !== '=') continue
    const i = record.packet.index,
      left = records.get(i - 2),
      right = records.get(i + 2),
      script = records.get(i + 3),
      space1 = scope.content.items[i - 1],
      space2 = scope.content.items[i + 1]
    if (
      !left ||
      !right ||
      !script ||
      space1?.str !== ' ' ||
      space2?.str !== ' ' ||
      !/^\p{L}$/u.test(left.original.str) ||
      !/^\p{L}$/u.test(right.original.str)
    )
      continue
    const a = left.original,
      m = record.original,
      b = right.original,
      s = script.original,
      run = [left, record, right, script],
      bounds = union(run.map((r) => r.envelope))
    if (
      !inside(bounds, band) ||
      a.height !== m.height ||
      b.height !== m.height ||
      !eq(a.transform[5], m.transform[5]) ||
      !eq(b.transform[5], m.transform[5]) ||
      !sameNumbers(a.transform.slice(0, 4), m.transform.slice(0, 4)) ||
      !sameNumbers(b.transform.slice(0, 4), m.transform.slice(0, 4))
    )
      continue
    if (
      !(
        s.height < m.height * 0.8 &&
        s.height > m.height * 0.5 &&
        s.transform[5] < m.transform[5]
      ) ||
      !eq(space1.transform[4], a.transform[4] + a.width) ||
      !eq(space1.transform[4] + space1.width, m.transform[4]) ||
      !eq(space2.transform[4], m.transform[4] + m.width) ||
      !eq(space2.transform[4] + space2.width, b.transform[4]) ||
      Math.abs(s.transform[4] - b.transform[4] - b.width) >= m.height * 0.1
    )
      continue
    const cells = [...new Set(run.map((r) => used.get(r.packet.index)))]
    if (
      cells.length < 2 ||
      cells.some((c) => !c || c.rowSpan !== 1 || c.colSpan !== 1 || c.row !== cells[0].row)
    )
      continue
    if (
      !cells.some((c) =>
        cellRecords(c).some(
          (r) =>
            r.original.height === m.height && r.original.transform[5] < m.transform[5] - m.height
        )
      )
    )
      continue
    if (obstructed(bounds, frame)) continue
    const identities = new Set(run.map((r) => r.packet.index))
    if (
      [...records.values()].some(
        (r) => !identities.has(r.packet.index) && overlap(r.envelope, bounds)
      )
    )
      continue
    crossings.push({ row: cells[0].row, baseline: m.transform[5], bounds })
  }
  for (const a of crossings) {
    const parallel = crossings.filter((b) => a.row === b.row && eq(a.baseline, b.baseline))
    if (parallel.length < 2 || !pairwiseSeparate(parallel)) continue
    const rows = new Map()
    for (const c of table.cells) {
      if (c.row <= a.row || c.rowSpan !== 1 || c.colSpan !== 1 || !c.sourceItems?.length) continue
      const rs = cellRecords(c),
        first = rs[0].original
      if (
        rs.some(
          (r) =>
            !inside(r.envelope, body) ||
            !eq(r.original.transform[5], first.transform[5]) ||
            r.original.height !== first.height
        )
      )
        continue
      const key = c.row + ':' + first.transform[5]
      if (!rows.has(key)) rows.set(key, [])
      rows.get(key).push(c)
    }
    if ([...rows.values()].filter((cs) => cs.length >= 3).length >= 2) return true
  }
  return false
}

function nativeCompleteBodyStructureConflict(table, selected, owners, inventory, rules, context) {
  try {
    const native = context.nativeGlyphContext,
      page = context.sourcePage,
      v = native.viewport,
      scale = context.viewport.scale,
      valid = (r) => rect(r) && r[0] < r[2] && r[1] < r[3],
      eq = (a, b) => Math.abs(a - b) < 1e-6
    if (
      native.pageNumber !== table.page ||
      JSON.stringify(page.graphicsBounds) !== JSON.stringify(native.graphicsBounds) ||
      !Array.isArray(native.operators?.fnArray) ||
      !Array.isArray(native.operators?.argsArray)
    )
      return false
    const retained = retainNativeRecoveryInputs(
      [
        table,
        inventory,
        rules,
        context.sourceContent,
        page,
        native.content,
        native.operators,
        native.glyphBounds,
        native.graphicsBounds,
        native.skippedSpaceGlyphs,
        context.viewport,
        v
      ],
      context.viewport,
      v
    )
    if (!retained) return false
    const content = {
        ...native.content,
        items: context.sourceContent.items.map((r, index) => ({
          ...r,
          fontName: native.content.items[index].fontName
        }))
      },
      viewport = { ...v, convertToViewportPoint: (x, y) => [x, v.height - y] },
      tokens = content.items
        .filter((r) => r.str?.trim())
        .map((r) => tableTextToken(r, viewport, 0)),
      packet = nativePageTextPacketInventory(page, tokens, { ...native, content, viewport }, true)
    if (!packet || !proveNativeUniqueWholeFonts(inventory, inventory)) return false
    if (inventory.length !== tokens.length) return false
    const records = new Map(),
      used = new Map(),
      union = (rs) => [
        Math.min(...rs.map((r) => r[0])),
        Math.min(...rs.map((r) => r[1])),
        Math.max(...rs.map((r) => r[2])),
        Math.max(...rs.map((r) => r[3]))
      ],
      inside = (r, b) => r[0] >= b[0] && r[2] <= b[2] && r[1] >= b[1] && r[3] <= b[3]
    for (const f of inventory) {
      const origin = f.sourceItem,
        r = context.sourceContent.items[origin.index],
        canonical = tableTextToken(r, context.viewport, 0),
        matches = packet.records.filter((p) => p.index === origin.index && p.r.str === origin.text)
      if (
        !r ||
        !canonical.horizontal ||
        !sameNumbers(canonical.rect, f.rect) ||
        !sameNumbers([canonical.height, canonical.baseline], [f.height, f.baseline]) ||
        matches.length !== 1 ||
        origin.pageNumber !== page.pageNumber ||
        r.str !== origin.text
      )
        return false
      const p = matches[0],
        ink = p.part.map((a) => a.g.ink)
      if (
        !valid(p.rect) ||
        !ink.length ||
        ink.some((a) => !valid(a)) ||
        !sameNumbers(
          p.rect.map((z) => z * scale),
          f.rect
        )
      )
        return false
      records.set(origin.index, {
        original: content.items[origin.index],
        packet: p,
        advance: p.rect,
        ink: union(ink),
        envelope: union([p.rect, ...ink]),
        font: f
      })
    }
    for (const f of selected) {
      if (!records.has(f.sourceItem.index)) return false
      used.set(f.sourceItem.index, owners.get(key(f.sourceItem)))
    }
    const selectedBounds = union(selected.map((f) => records.get(f.sourceItem.index).envelope))
    // Remote zero metrics remain complete glyph witnesses, never font proofs.
    for (const r of records.values()) {
      const s = content.styles[r.original.fontName]
      if (s.ascent > 0 && Number.isFinite(s.descent) && s.descent <= 0) continue
      if (
        used.has(r.packet.index) ||
        !(
          r.envelope[2] < selectedBounds[0] ||
          r.envelope[0] > selectedBounds[2] ||
          r.envelope[3] < selectedBounds[1] ||
          r.envelope[1] > selectedBounds[3]
        )
      )
        return false
    }
    const paintMap = new Map(),
      nativeRules = collectTableRules(native.operators, context.viewport, paintMap)
    if (
      nativeRules.length !== rules.length ||
      rules.some((r) => nativeRules.filter((n) => sameNumbers(n, r)).length !== 1) ||
      nativeRules.some((n) => rules.filter((r) => sameNumbers(n, r)).length !== 1)
    )
      return false
    const identity = native.graphicsBounds.map((g) => ({
        kind: g.kind,
        operationIndex: g.operationIndex,
        rect: g.normalizedRect.map((z, i) => z * (i % 2 ? v.height : v.width) * scale)
      })),
      precise = preciseNativeGraphicsBounds({
        nativeGlyphContext: native,
        viewport: context.viewport,
        rulePaintBounds: paintMap,
        nativePaintIdentityGraphics: identity,
        nativeEvidenceGraphics: identity
      })
    if (!precise || precise.length !== identity.length || precise.some((r) => !valid(r)))
      return false
    const visibility = {
        operators: native.operators,
        viewport: context.viewport,
        rulePaintBounds: paintMap,
        nativePaintIdentityGraphics: identity.map((g, i) => ({ ...g, rect: precise[i] }))
      },
      envelopes = [...records.values()].map((r) => ({
        envelope: r.envelope.map((z) => z * scale)
      })),
      groups = []
    for (const r of rules) {
      if (!rect(r) || r[1] !== r[3]) continue
      let group = groups.find((g) => eq(g[0][0], r[0]) && eq(g[0][2], r[2]))
      if (!group) groups.push((group = []))
      group.push(r)
    }
    const visible = (rs) =>
        rs.every((r) => visibleNativeHeaderRule(r, visibility, envelopes) === true),
      record = (o) => records.get(o.index),
      cellRecords = (c) => (c.sourceItems ?? []).map(record)
    if (
      nativeBoundedPartitionConflict(table, {
        records,
        used,
        groups,
        visible,
        paintMap,
        scale,
        content,
        rules,
        identity,
        precise
      }) &&
      retained()
    )
      return true
    if (Array.isArray(table.unassigned) && table.unassigned.length) {
      const missing = [],
        complete = []
      for (const group of groups) {
        if (group.length !== 4 || !visible(group)) continue
        const rails = [...group].sort((a, b) => a[1] - b[1]),
          above = paintMap.get(rails[1].join(',')),
          below = paintMap.get(rails[2].join(',')),
          bounds = [rails[0][0] / scale, above[3] / scale, rails[0][2] / scale, below[1] / scale],
          omitted = [...records.values()].filter(
            (r) => !used.has(r.packet.index) && inside(r.envelope, bounds)
          )
        if (!omitted.length) continue
        const height = Math.max(...omitted.map((r) => r.original.height)),
          baselines = [
            ...new Set(
              omitted
                .filter((r) => r.original.height === height)
                .map((r) => r.original.transform[5])
            )
          ],
          lanes = table.cells
            .filter((c) => c.row > 0 && c.sourceItems?.length)
            .map((c) => ({
              column: c.column,
              records: cellRecords(c)
            }))
            .filter((c) => c.records.every((r) => inside(r.envelope, bounds)))
        if (baselines.length < 2 || lanes.length < 3) continue
        lanes.sort((a, b) => a.column - b.column)
        const top = paintMap.get(rails[0].join(',')),
          headerBounds = [bounds[0], top[3] / scale, bounds[2], above[1] / scale],
          headers = table.cells
            .filter(
              (c) => c.row === 0 && c.rowSpan === 1 && c.colSpan === 1 && c.sourceItems?.length
            )
            .map((c) => ({ column: c.column, records: cellRecords(c) }))
            .filter((c) => c.records.every((r) => inside(r.envelope, headerBounds)))
            .sort(
              (a, b) =>
                union(a.records.map((r) => r.envelope))[0] -
                union(b.records.map((r) => r.envelope))[0]
            )
        if (headers.length !== lanes.length || headers.some((h, i) => h.column !== lanes[i].column))
          continue
        const spans = lanes.map((lane, i) =>
          union([...lane.records, ...headers[i].records].map((a) => a.envelope))
        )
        if (spans.some((span, i) => i && span[0] <= spans[i - 1][2])) continue
        if (
          !baselines.every((baseline) => {
            const row = omitted.filter((r) => eq(r.original.transform[5], baseline)),
              columns = new Set()
            for (const r of row) {
              const matched = lanes.filter((lane) => {
                const i = lanes.indexOf(lane),
                  left = i ? (spans[i - 1][2] + spans[i][0]) / 2 : bounds[0],
                  right = i + 1 < lanes.length ? (spans[i][2] + spans[i + 1][0]) / 2 : bounds[2]
                return (
                  r.advance[0] >= left &&
                  r.advance[2] <= right &&
                  lane.records.some(
                    (a) =>
                      a.original.fontName === r.original.fontName &&
                      a.original.height === r.original.height
                  )
                )
              })
              if (matched.length !== 1) return false
              columns.add(matched[0].column)
            }
            return columns.size >= 3
          })
        )
          continue
        missing.push(...omitted)
        complete.push(group)
      }
      const expectedUnassigned = [...table.unassigned].sort()
      if (
        complete.length &&
        missing.length === expectedUnassigned.length &&
        missing
          .map((r) => r.original.str)
          .sort()
          .every((s, i) => s === expectedUnassigned[i]) &&
        retained()
      )
        return true
    }
    if (!table.caption && !rules.length && !identity.length) {
      const cols = table.grid[0].length,
        scripted = (rs, height) =>
          rs.some((r) => r.original.height < height * 0.8 && r.original.height > height * 0.5),
        relation = (r) => /^[=<>≤≥≠]$/u.test(r.original.str),
        headers = table.cells.filter((c) => c.row === 0)
      if (
        headers.length === cols &&
        headers.every((c) => {
          const rs = cellRecords(c),
            height = Math.max(...rs.map((r) => r.original.height))
          return c.colSpan === 1 && rs.some(relation) && scripted(rs, height)
        })
      ) {
        const prose = table.cells.filter(
          (c) =>
            c.colSpan === cols &&
            c.sourceItems?.length === 1 &&
            record(c.sourceItems[0]).original.str.trim().split(/\s+/u).length >= 3 &&
            record(c.sourceItems[0])
              .original.str.trim()
              .split(/\s+/u)
              .every((word) => /^\p{L}{2,}[,;:.!?]?$/u.test(word))
        )
        for (const c of table.cells) {
          if (
            c.colSpan !== 1 ||
            !c.sourceItems?.length ||
            !prose.some((p) => p.row > 0 && p.row < c.row)
          )
            continue
          const next = table.cells.find(
            (b) =>
              b.row === c.row &&
              b.column === c.column + 1 &&
              b.colSpan === 1 &&
              b.sourceItems?.length
          )
          if (!next) continue
          const a = record(c.sourceItems.at(-1)),
            b = record(next.sourceItems[0]),
            space = content.items[a.packet.index + 1],
            aa = a.original,
            bb = b.original
          if (
            b.packet.index !== a.packet.index + 2 ||
            space?.str !== ' ' ||
            !relation(b) ||
            aa.height !== bb.height ||
            !sameNumbers(aa.transform.slice(0, 4), bb.transform.slice(0, 4)) ||
            !eq(aa.transform[5], bb.transform[5]) ||
            !eq(space.transform[4], aa.transform[4] + aa.width) ||
            !eq(space.transform[4] + space.width, bb.transform[4]) ||
            !(space.width > 0 && space.width < aa.height) ||
            !scripted(cellRecords(c), aa.height) ||
            !scripted(cellRecords(next), bb.height)
          )
            continue
          const bounds = union([...cellRecords(c), ...cellRecords(next)].map((r) => r.envelope))
          if (
            ![...records.values()].some(
              (r) => !used.has(r.packet.index) && inside(r.envelope, bounds)
            ) &&
            retained()
          )
            return true
        }
      }
    }
    if (table.cells.every((c) => c.rowSpan === 1 && c.colSpan === 1)) {
      const frames = groups.filter((g) => g.length === 3 && visible(g))
      if (frames.length !== 1) return false
      const frameRules = [...frames[0]].sort((a, b) => a[1] - b[1]),
        framePaints = frameRules.map((r) => paintMap.get(r.join(','))),
        frame = [frameRules[0][0], framePaints[0][1], frameRules[0][2], framePaints[2][3]].map(
          (z) => z / scale
        ),
        frameOperations = new Set()
      for (const paint of framePaints) {
        const matches = identity
          .map((g, i) => ({ g, bounds: precise[i] }))
          .filter(({ g, bounds }) => g.kind === 'path' && sameNumbers(bounds, paint))
        if (matches.length !== 1 || frameOperations.has(matches[0].g.operationIndex)) return false
        frameOperations.add(matches[0].g.operationIndex)
      }
      const splits = []
      for (const [i, n] of content.items.entries()) {
        const close = n.str === '{' ? '}' : n.str === '(' ? ')' : null
        if (!close || !used.has(i)) continue
        const j = content.items.findIndex(
          (b, k) =>
            k > i &&
            b.str === close &&
            b.fontName === n.fontName &&
            b.height === n.height &&
            sameNumbers(b.transform.slice(0, 4), n.transform.slice(0, 4)) &&
            eq(b.transform[5], n.transform[5])
        )
        if (j < 0 || !used.has(j)) continue
        const a = used.get(i),
          b = used.get(j)
        if (a === b || a.row !== b.row) continue
        const seq = content.items.slice(i, j + 1)
        if (
          seq.some(
            (z, k) =>
              !z.str.trim() || used.get(i + k)?.row !== a.row || !eq(z.transform[5], n.transform[5])
          ) ||
          seq.slice(1).some((z, k) => {
            const p = seq[k],
              gap = z.transform[4] - p.transform[4] - p.width
            return gap < -1e-6 || gap >= Math.min(z.width, p.width)
          })
        )
          continue
        if (seq.slice(1, -1).some((z) => z.str === n.str || z.str === close)) continue
        const rs = seq.map((_, k) => records.get(i + k)),
          bounds = union(rs.map((r) => r.envelope))
        if (
          [...records.values()].some(
            (r) => (r.packet.index < i || r.packet.index > j) && inside(r.envelope, bounds)
          )
        )
          continue
        if (
          !inside(bounds, frame) ||
          identity.some((g, k) => {
            if (frameOperations.has(g.operationIndex)) return false
            const paint = precise[k].map((z) => z / scale)
            return (
              paint[0] < bounds[2] &&
              paint[2] > bounds[0] &&
              paint[1] < bounds[3] &&
              paint[3] > bounds[1]
            )
          })
        )
          continue
        splits.push({ i, j, row: a.row })
      }
      if (
        splits.some((a) => splits.some((b) => a.row !== b.row && (a.j < b.i || b.j < a.i))) &&
        retained()
      )
        return true
    }
    return false
  } catch {
    return false
  }
}

function nativeCompleteStructureSourceConflict(table, inventory, rules, context) {
  try {
    const t = nativeRecoveryOwnValues(table),
      c = nativeRecoveryOwnValues(context),
      raw = c?.sourceContent,
      page = c?.sourcePage?.pageNumber,
      v = c?.viewport,
      native = c?.nativeGlyphContext
    if (
      !t ||
      !c ||
      t.parts ||
      !rect(t.cropRect) ||
      !Array.isArray(t.grid) ||
      t.grid.length < 2 ||
      !Array.isArray(t.cells) ||
      !Array.isArray(inventory) ||
      !Array.isArray(rules) ||
      !raw?.items ||
      c.content !== raw ||
      !native?.content?.items ||
      native.content.items.length !== raw.items.length ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !(v?.scale > 0) ||
      v.rotation !== 0 ||
      native.viewport?.rotation !== 0 ||
      native.viewport.scale !== 1 ||
      t.page !== page ||
      c.sourcePage.width !== native.viewport.width ||
      c.sourcePage.height !== native.viewport.height ||
      c.sourcePage.invalidGraphicsBounds !== 0 ||
      v.width !== native.viewport.width * v.scale ||
      v.height !== native.viewport.height * v.scale ||
      !sameNumbers(native.viewport.transform, [1, 0, 0, -1, 0, native.viewport.height]) ||
      !sameNumbers(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height])
    )
      return false
    const retained = retainNativeRecoveryInputs(
      [table, inventory, rules, raw, c.sourcePage, native.content, v, native.viewport],
      v,
      native.viewport
    )
    if (!retained) return false
    const forward = new Map(),
      backward = new Map()
    for (const [index, n] of native.content.items.entries()) {
      const r = raw.items[index],
        ns = native.content.styles?.[n.fontName],
        rs = raw.styles?.[r?.fontName]
      if (
        !r ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => n[k] !== r[k]) ||
        !sameNumbers(n.transform, r.transform) ||
        JSON.stringify(ns) !== JSON.stringify(rs) ||
        ns?.vertical !== false ||
        !Number.isFinite(ns.ascent) ||
        !Number.isFinite(ns.descent) ||
        ns.descent > 0 ||
        (forward.has(n.fontName) && forward.get(n.fontName) !== r.fontName) ||
        (backward.has(r.fontName) && backward.get(r.fontName) !== n.fontName) ||
        (r.str?.trim() &&
          (r.sourceItem?.pageNumber !== page ||
            r.sourceItem.index !== index ||
            r.sourceItem.text !== n.str))
      )
        return false
      forward.set(n.fontName, r.fontName)
      backward.set(r.fontName, n.fontName)
    }
    const columns = t.grid[0]?.length
    if (!(columns >= 2) || t.grid.some((r) => !Array.isArray(r) || r.length !== columns))
      return false
    const slots = new Set(),
      selected = [],
      owners = new Map()
    for (const cell of t.cells) {
      if (
        ![cell.row, cell.column, cell.rowSpan, cell.colSpan].every(Number.isSafeInteger) ||
        cell.row < 0 ||
        cell.column < 0 ||
        cell.rowSpan < 1 ||
        cell.colSpan < 1 ||
        cell.row + cell.rowSpan > t.grid.length ||
        cell.column + cell.colSpan > columns ||
        cell.sourceSegments?.length ||
        !Array.isArray(cell.sourceRects) ||
        !Array.isArray(cell.sourceItems ?? []) ||
        cell.sourceRects.length !== (cell.sourceItems?.length ?? 0) ||
        t.grid[cell.row]?.[cell.column] !== cell.text ||
        !!cell.text.trim() !== !!cell.sourceItems?.length
      )
        return false
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
        for (let col = cell.column; col < cell.column + cell.colSpan; col++) {
          const slot = r + ':' + col
          if (slots.has(slot)) return false
          slots.add(slot)
        }
      const remaining = [...cell.sourceRects]
      for (const origin of cell.sourceItems ?? []) {
        const fonts = inventory.filter((f) => f.sourceItem && key(f.sourceItem) === key(origin)),
          item = raw.items[origin.index],
          original = native.content.items[origin.index]
        if (
          owners.has(key(origin)) ||
          origin.pageNumber !== page ||
          fonts.length !== 1 ||
          item?.str !== origin.text ||
          original?.str !== origin.text ||
          backward.get(item.fontName) !== original.fontName ||
          item.width !== original.width ||
          item.height !== original.height ||
          item.dir !== original.dir ||
          item.hasEOL !== original.hasEOL ||
          !Array.isArray(item.transform) ||
          item.transform.length !== 6 ||
          item.transform.some((z, i) => z !== original.transform?.[i]) ||
          !item.transform.every(Number.isFinite) ||
          !(item.transform[0] > 0) ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          !(item.transform[3] > 0)
        )
          return false
        const font = fonts[0],
          style = raw.styles?.[item.fontName],
          ns = native.content.styles?.[original.fontName],
          canonical = tableTextToken(item, v, 0),
          matches = remaining.filter(
            (r) => rect(r) && r.every((z, i) => Math.abs(z - font.rect[i]) < 1e-6)
          )
        if (
          !style ||
          !ns ||
          style.vertical !== false ||
          ns.vertical !== false ||
          !Number.isFinite(style.ascent) ||
          !(style.ascent > 0) ||
          !Number.isFinite(style.descent) ||
          style.ascent !== ns.ascent ||
          style.descent !== ns.descent ||
          matches.length !== 1 ||
          !canonical.horizontal ||
          !rect(canonical.rect) ||
          canonical.rect[0] >= canonical.rect[2] ||
          canonical.rect[1] >= canonical.rect[3] ||
          !Number.isFinite(font.height) ||
          !Number.isFinite(font.baseline) ||
          Math.abs(canonical.height - font.height) > 1e-6 ||
          Math.abs(canonical.baseline - font.baseline) > 1e-6 ||
          canonical.rect.some((z, i) => Math.abs(z - font.rect[i]) > 1e-6)
        )
          return false
        remaining.splice(remaining.indexOf(matches[0]), 1)
        selected.push(font)
        owners.set(key(origin), cell)
      }
      if (remaining.length) return false
    }
    if (!proveNativeUniqueWholeFonts(selected, inventory)) return false
    if (
      inventory.some(
        (f) => f.text?.trim() && (!rect(f.rect) || f.rect[0] >= f.rect[2] || f.rect[1] >= f.rect[3])
      )
    )
      return false
    return (
      nativeCompleteBodyStructureConflict(t, selected, owners, inventory, rules, c) && retained()
    )
  } catch {
    return false
  }
}

export function reviewFinalNativeTableSources(table, inventory, rules, measuredRuns, context) {
  if (table.parts)
    return {
      ...table,
      parts: table.parts.map((part) => {
        const checked = reviewFinalNativeTableSources(
          { ...part, cropRect: part.cropRect ?? table.cropRect },
          inventory,
          rules,
          measuredRuns,
          context
        )
        if (
          checked.issues === part.issues &&
          checked.cells === part.cells &&
          checked.unreliableMathSourceItems === part.unreliableMathSourceItems
        )
          return part
        const next = { ...part, issues: checked.issues, cells: checked.cells }
        if (checked.unreliableMathSourceItems)
          next.unreliableMathSourceItems = checked.unreliableMathSourceItems
        else delete next.unreliableMathSourceItems
        return next
      })
    }
  const projectionConflicts = nativeFormattedProjectionConflicts(table, inventory, context),
    fractionWarnings = proveNativeFractionWarning(table, inventory, rules, context)
  const ambiguous =
    projectionConflicts.length ||
    nativeCrossedPointIntervalRecords(table, inventory, context) ||
    nativeFolioCellConflict(table, inventory, rules, context) ||
    nativeTableSourceConflicts(table, inventory, true).length ||
    nativeTableLayoutConflicts(table, inventory, rules, measuredRuns, context).length ||
    proveNativeFlattenedFraction(table, inventory, rules, context).length ||
    fractionWarnings.length ||
    nativeFractionRowConflict(table, inventory, rules, context) ||
    nativeEncodedSourceConflict(table, inventory, context)
  // Preserve the original conflict short-circuit. Collect this additional,
  // read-only evidence afterwards even if an earlier conflict already won.
  const panelAmbiguous =
    !ambiguous &&
    (nativeCrossPanelFieldConflict(table, rules, context) ||
      nativeFinalColumnOwnershipConflict(table, inventory, rules, context) ||
      nativeCollapsedSelectedSourceConflict(table, inventory, rules, context) ||
      nativeSparseOrDividedSourceConflict(table, inventory, rules, context) ||
      nativeHeaderFirstSourceConflict(table, inventory, rules, context) ||
      nativeCompleteStructureSourceConflict(table, inventory, rules, context))
  const mathSources = [
    ...(ambiguous ? nativeTableUnreliableMathSourceItems(table, inventory, rules, context) : []),
    ...projectionConflicts.flatMap((conflict) => conflict.sources),
    ...fractionWarnings.flatMap((conflict) => conflict.sources)
  ]
    .filter((origin, index, all) => all.findIndex((other) => key(other) === key(origin)) === index)
    .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
  const result =
    ambiguous || panelAmbiguous
      ? {
          ...table,
          ...(projectionConflicts.length
            ? {
                cells: table.cells.map((cell) => {
                  if (!projectionConflicts.some((conflict) => conflict.cell === cell)) return cell
                  const retained = { ...cell }
                  delete retained.textRuns
                  return retained
                })
              }
            : {}),
          issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
          reviewCandidate: false
        }
      : table
  if (mathSources.length) return { ...result, unreliableMathSourceItems: mathSources }
  if (!table.unreliableMathSourceItems) return result
  const withoutStaleMath = { ...result }
  delete withoutStaleMath.unreliableMathSourceItems
  return withoutStaleMath
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

// A complete glossary header and repeated starts in all three owned fields
// establish two possible records inside a single model row. This proves only
// ambiguity: keep the image, original claims and grid rather than inventing rows.
function repeatedNativeGlossaryRecords(proved, lanes) {
  const header = proved
    .filter((p) => p.cell.row === 0)
    .sort((a, b) => a.cell.column - b.cell.column)
  if (
    header.length !== 3 ||
    header.some(
      (p, column) => p.cell.column !== column || p.cell.rowSpan !== 1 || p.cell.colSpan !== 1
    ) ||
    header.map((p) => compact(p.cell.text).toLowerCase()).join('|') !== 'symbol|meaning|definedin'
  )
    return false
  const [symbols, meanings, references] = lanes
  if (
    symbols.rows.length < 2 ||
    references.rows.length !== symbols.rows.length ||
    symbols.rows.some((r) => !/\p{L}/u.test(r.text) || /\p{L}{3,}/u.test(compact(r.text))) ||
    references.rows.some(
      (r) => !/^(?:App|Lem|Thm|Prop|Eq|Def|Sec)\.[A-Z](?:\.\d+)*$/u.test(compact(r.text))
    ) ||
    new Set(symbols.rows.map((r) => compact(r.text))).size !== symbols.rows.length
  )
    return false
  const h = Math.max(...lanes.map((lane) => lane.h))
  if (lanes.some((lane) => Math.abs(lane.h - h) > h * 0.02)) return false
  const aligned = (line, lane) =>
    lane.rows.filter((r) => Math.abs(r.baseline - line.baseline) < h * 0.15)
  const definitions = []
  for (let index = 0; index < symbols.rows.length; index++) {
    const symbol = symbols.rows[index],
      reference = references.rows[index],
      meaning = aligned(symbol, meanings)
    if (
      (index &&
        (symbol.baseline - symbols.rows[index - 1].baseline < h * 0.9 ||
          symbol.baseline - symbols.rows[index - 1].baseline > h * 2.5)) ||
      Math.abs(symbol.first.rect[0] - symbols.rows[0].first.rect[0]) > h * 0.15 ||
      Math.abs(reference.baseline - symbol.baseline) >= h * 0.15 ||
      Math.abs(reference.first.rect[0] - references.rows[0].first.rect[0]) > h * 0.15 ||
      meaning.length !== 1 ||
      !meaning[0].text.trim()
    )
      return false
    definitions.push(meaning[0])
  }
  return definitions.every(
    (line) => Math.abs(line.first.rect[0] - definitions[0].first.rect[0]) < h * 0.15
  )
}

// Whole native source ownership is necessary for these review triggers. The
// repeated closed fields establish ambiguity, not a unique replacement grid.
// Independent complete numeric records cannot own the close of one native
// confidence interval and the open of the next. This proves review ambiguity,
// not a replacement row boundary or any new source/cell ownership.
function crossedNativeIntervalRecords(table, proved, native, counts) {
  if (table.parts?.length || table.cropRects?.length || table.grid[0]?.length !== 5) return false
  const number = '[+−-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)',
    opening = new RegExp(`^\\[${number},$`, 'u'),
    closing = new RegExp(`^${number}\\]$`, 'u'),
    scalar = new RegExp(`^${number}$`, 'u')
  const actual = (f, page) =>
    f?.sourceItem &&
    Number.isSafeInteger(f.sourceItem.pageNumber) &&
    f.sourceItem.pageNumber > 0 &&
    (page === undefined || f.sourceItem.pageNumber === page) &&
    Number.isSafeInteger(f.sourceItem.index) &&
    f.sourceItem.index >= 0 &&
    f.sourceItem.text === f.text &&
    native.get(key(f.sourceItem)) === f &&
    counts.get(key(f.sourceItem)) === 1 &&
    f.horizontal &&
    rect(f.rect) &&
    f.rect[0] < f.rect[2] &&
    f.rect[1] < f.rect[3] &&
    Number.isFinite(f.baseline) &&
    Number.isFinite(f.height) &&
    f.height > 0 &&
    Number.isFinite(f.fontAscent) &&
    f.fontAscent > 0 &&
    Number.isFinite(f.fontDescent) &&
    f.fontDescent <= 0
  const whole = (p, page) =>
    p &&
    Number.isSafeInteger(p.cell.row) &&
    Number.isSafeInteger(p.cell.column) &&
    p.cell.row >= 0 &&
    p.cell.row < table.grid.length &&
    p.cell.column >= 0 &&
    p.cell.column < 5 &&
    p.cell.rowSpan === 1 &&
    p.cell.colSpan === 1 &&
    p.fonts.every((f) => actual(f, page)) &&
    compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join(''))
  const at = (row, column) => {
    const cells = proved.filter((p) => p.cell.row === row && p.cell.column === column)
    return cells.length === 1 ? cells[0] : undefined
  }
  for (const mixed of proved) {
    if (mixed.cell.row < 1 || mixed.cell.column !== 4 || !whole(mixed) || mixed.fonts.length !== 2)
      continue
    const [tail, nextHead] = [...mixed.fonts].sort((a, b) => a.baseline - b.baseline),
      page = tail.sourceItem.pageNumber,
      h = tail.height,
      next = at(mixed.cell.row + 1, 4),
      header = at(0, 4)
    if (
      (table.page !== undefined && table.page !== page) ||
      !closing.test(tail.text) ||
      !opening.test(nextHead.text) ||
      !whole(mixed, page) ||
      !whole(next, page) ||
      next.fonts.length !== 1 ||
      !closing.test(next.fonts[0].text) ||
      !whole(header, page) ||
      !/\bCI\b/u.test(header.cell.text)
    )
      continue
    const end = next.fonts[0],
      gap = end.baseline - nextHead.baseline,
      compatible = (f) =>
        actual(f, page) &&
        f.height === h &&
        f.fontAscent === tail.fontAscent &&
        f.fontDescent === tail.fontDescent,
      anchors = (row, baseline) => {
        const fields = [0, 2, 3].map((column) => at(row, column))
        if (
          fields.some(
            (p) =>
              !whole(p, page) ||
              p.fonts.length !== 1 ||
              !compatible(p.fonts[0]) ||
              p.fonts[0].baseline !== baseline
          ) ||
          !/^\d+$/u.test(fields[0].cell.text) ||
          !scalar.test(fields[1].cell.text) ||
          !/^(?:0?\.\d+|[01](?:\.0+)?)$/u.test(fields[2].cell.text) ||
          fields.some((p, i) => i && fields[i - 1].box[2] >= p.box[0]) ||
          fields.at(-1).box[2] >= Math.min(tail.rect[0], nextHead.rect[0], end.rect[0])
        )
          return
        return fields
      },
      firstAnchors = anchors(mixed.cell.row, tail.baseline),
      nextAnchors = anchors(next.cell.row, end.baseline)
    if (
      !compatible(nextHead) ||
      !compatible(end) ||
      !firstAnchors ||
      !nextAnchors ||
      tail.baseline >= nextHead.baseline ||
      gap < h * 0.9 ||
      gap > h * 1.5 ||
      nextAnchors.some((p, i) => Math.abs(p.box[0] - firstAnchors[i].box[0]) > h * 0.15) ||
      [nextHead, end].some((f) => Math.abs(f.rect[2] - tail.rect[2]) > h * 0.15)
    )
      continue
    const firstHeads = [...native.values()].filter(
      (f) =>
        compatible(f) &&
        opening.test(f.text) &&
        f.baseline < tail.baseline &&
        Math.abs(tail.baseline - f.baseline - gap) <= h * 0.15 &&
        Math.abs(f.rect[2] - nextHead.rect[2]) <= h * 0.15 &&
        f.rect[0] > firstAnchors.at(-1).box[2]
    )
    if (
      firstHeads.length === 1 &&
      new Set([firstHeads[0], tail, nextHead, end].map((f) => key(f.sourceItem))).size === 4
    )
      return true
  }
  return false
}

// A complete two-line native stub already owned by one peer record can expose
// the same complete fields split across rows elsewhere. This is only a review
// trigger: preserve the original grid and claims rather than inventing rows.
function splitWrappedNativeStubRecords(table, proved) {
  if (table.parts?.length || table.cropRects?.length) return false
  const columns = table.grid[0]?.length
  if (!Number.isSafeInteger(columns) || columns < 4 || columns > 6) return false
  const literal = (s) => typeof s === 'string' && /^[\p{L}][\p{L}\p{M}'’ -]*$/u.test(s)
  const interval = (s) =>
    typeof s === 'string' &&
    /^[+−-]?\d+(?:\.\d+)?\s*\[\s*[+−-]?\d+(?:\.\d+)?\s*,\s*[+−-]?\d+(?:\.\d+)?\s*\]$/u.test(s)
  const metrics = (f) =>
    Number.isFinite(f.height) &&
    f.height > 0 &&
    Number.isFinite(f.fontAscent) &&
    f.fontAscent > 0 &&
    Number.isFinite(f.fontDescent) &&
    f.fontDescent <= 0
  const whole = (p) =>
    Number.isSafeInteger(p.cell.row) &&
    Number.isSafeInteger(p.cell.column) &&
    p.cell.row >= 0 &&
    p.cell.column >= 0 &&
    p.cell.column < columns &&
    p.cell.rowSpan === 1 &&
    p.cell.colSpan === 1 &&
    p.fonts.every(
      (f) =>
        metrics(f) &&
        Number.isSafeInteger(f.sourceItem?.pageNumber) &&
        f.sourceItem.pageNumber > 0 &&
        f.sourceItem.pageNumber === p.fonts[0].sourceItem.pageNumber
    ) &&
    compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join(''))
  const fieldsAt = (row) =>
    proved
      .filter((p) => p.cell.row === row && p.cell.column > 0)
      .sort((a, b) => a.cell.column - b.cell.column)
  const data = (row, baseline, h, pageNumber, reference) => {
    const fields = fieldsAt(row)
    return (
      fields.length === 3 &&
      fields.every(
        (p, i) =>
          whole(p) &&
          p.fonts.length === 1 &&
          p.fonts[0].height === h &&
          p.fonts[0].sourceItem.pageNumber === pageNumber &&
          p.fonts[0].baseline === baseline &&
          (!reference ||
            (p.cell.column === reference[i].cell.column &&
              Math.abs(p.box[0] - reference[i].box[0]) <= h * 0.15))
      ) &&
      literal(fields[0].cell.text) &&
      fields.slice(1).every((p) => interval(p.cell.text)) &&
      fields.every((p, i) => !i || fields[i - 1].box[2] < p.box[0])
    )
  }
  for (const peer of proved) {
    if (
      peer.cell.row < 1 ||
      peer.cell.column !== 0 ||
      !whole(peer) ||
      peer.fonts.length !== 2 ||
      peer.fonts.some((f) => !literal(f.text))
    )
      continue
    const [prefix, suffix] = [...peer.fonts].sort((a, b) => a.baseline - b.baseline),
      h = prefix.height,
      gap = suffix.baseline - prefix.baseline,
      pageNumber = prefix.sourceItem.pageNumber
    if (
      suffix.height !== h ||
      suffix.fontAscent !== prefix.fontAscent ||
      suffix.fontDescent !== prefix.fontDescent ||
      gap < h * 0.9 ||
      gap > h * 1.5 ||
      Math.abs(prefix.rect[0] - suffix.rect[0]) > h * 0.15 ||
      !data(peer.cell.row, suffix.baseline, h, pageNumber)
    )
      continue
    const split = []
    for (const first of proved) {
      if (
        first.cell.row < 1 ||
        first.cell.column !== 0 ||
        !whole(first) ||
        first.fonts.length !== 1 ||
        first.fonts[0].text !== prefix.text ||
        first.fonts[0].sourceItem.pageNumber !== pageNumber ||
        first.fonts[0].height !== h ||
        first.fonts[0].fontAscent !== prefix.fontAscent ||
        first.fonts[0].fontDescent !== prefix.fontDescent ||
        Math.abs(first.fonts[0].rect[0] - prefix.rect[0]) > h * 0.15 ||
        table.cells.some((c) => c.row === first.cell.row && c.column > 0 && c.text?.trim())
      )
        continue
      const next = proved.filter(
        (p) =>
          p.cell.row === first.cell.row + 1 &&
          p.cell.column === 0 &&
          whole(p) &&
          p.fonts.length === 1 &&
          p.fonts[0].text === suffix.text &&
          p.fonts[0].sourceItem.pageNumber === pageNumber &&
          p.fonts[0].height === h &&
          p.fonts[0].fontAscent === suffix.fontAscent &&
          p.fonts[0].fontDescent === suffix.fontDescent &&
          Math.abs(p.fonts[0].rect[0] - suffix.rect[0]) <= h * 0.15 &&
          Math.abs(p.fonts[0].baseline - first.fonts[0].baseline - gap) <= h * 0.15 &&
          data(p.cell.row, p.fonts[0].baseline, h, pageNumber, fieldsAt(peer.cell.row))
      )
      if (next.length === 1) split.push({ first, next: next[0] })
    }
    if (split.length >= 2) return true
  }
  return false
}

function repeatedNativeRecordAmbiguity(table, proved) {
  const columns = table.grid[0]?.length
  if (columns !== 2 && columns !== 3) return false
  const lines = (fonts) => {
    const h = Math.max(...fonts.map((f) => f.height)),
      grouped = []
    if (!Number.isFinite(h) || h <= 0) return
    for (const f of [...fonts]
      .filter((f) => f.height >= h * 0.8)
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const last = grouped.at(-1)
      if (last && Math.abs(last.baseline - f.baseline) < h * 0.15) last.fonts.push(f)
      else grouped.push({ baseline: f.baseline, fonts: [f] })
    }
    return {
      h,
      rows: grouped.map((row) => ({
        ...row,
        text: row.fonts.map((f) => f.text).join(''),
        first: row.fonts[0]
      }))
    }
  }
  for (let row = 1; row < table.grid.length; row++) {
    const cells = proved
      .filter((p) => p.cell.row === row)
      .sort((a, b) => a.cell.column - b.cell.column)
    if (
      cells.length !== columns ||
      cells.some((p, c) => p.cell.column !== c || p.cell.rowSpan !== 1 || p.cell.colSpan !== 1)
    )
      continue
    const characters = (s) => [...compact(s)].sort().join('')
    const projected = (fonts) =>
      fonts
        .map((f, i) => {
          const next = fonts[i + 1]
          return /\p{L}-$/u.test(f.text) &&
            next &&
            /^\p{Ll}/u.test(next.text) &&
            next.baseline - f.baseline > f.height * 0.5 &&
            next.rect[0] <= f.rect[0] + f.height * 0.2
            ? f.text.slice(0, -1)
            : f.text
        })
        .join('')
    if (
      cells.some(
        (p) =>
          characters(p.cell.text) !== characters(p.fonts.map((f) => f.text).join('')) &&
          characters(p.cell.text) !== characters(projected(p.fonts))
      )
    )
      continue
    const lanes = cells.map((p) => lines(p.fonts))
    if (lanes.some((l) => !l)) continue
    const align = (line, lane) =>
      lane.rows.filter(
        (r) => Math.abs(r.baseline - line.baseline) < Math.min(lanes[0].h, lane.h) * 0.15
      )
    if (columns === 2) {
      const starts = lanes[0].rows.flatMap((line) => {
        const m =
          /^([A-Za-z][A-Za-z0-9_]*\.)([A-Za-z][A-Za-z0-9_]*)(?:\.[A-Za-z][A-Za-z0-9_]*)*$/u.exec(
            line.text
          )
        return m ? [{ line, namespace: m[1] }] : []
      })
      for (let n = 1; n < starts.length; n++) {
        const a = starts[n - 1],
          b = starts[n]
        if (
          a.namespace !== b.namespace ||
          a.line.text === b.line.text ||
          /[_-]$/u.test(a.line.text) ||
          b.line.baseline - a.line.baseline < lanes[0].h * 0.9 ||
          b.line.baseline - a.line.baseline > lanes[0].h * 2.5 ||
          Math.abs(a.line.first.rect[0] - b.line.first.rect[0]) > lanes[0].h * 0.15
        )
          continue
        const peers = [a.line, b.line].map((l) => align(l, lanes[1]))
        if (
          peers.every(
            (p) => p.length === 1 && (p[0].text.match(/\p{L}{2,}/gu) ?? []).length >= 2
          ) &&
          Math.abs(peers[0][0].first.rect[0] - peers[1][0].first.rect[0]) < lanes[1].h * 0.15
        )
          return true
      }
    } else {
      if (repeatedNativeGlossaryRecords(proved, lanes)) return true
      const ranges = lanes[2].rows
      if (
        ranges.length < 2 ||
        ranges.some((r) => !/^\|[A-Za-z]\|[≥⩾≤⩽]\d+$/u.test(compact(r.text))) ||
        ranges.some(
          (r, i) =>
            i &&
            (r.baseline - ranges[i - 1].baseline < lanes[2].h * 0.9 ||
              r.baseline - ranges[i - 1].baseline > lanes[2].h * 2.5)
        )
      )
        continue
      const stubs = ranges.map((r) => align(r, lanes[0])),
        formulas = ranges.map((r) => align(r, lanes[1]))
      if (
        stubs.some((rs) => rs.length !== 1 || !/^\p{Lu}\p{L}+\s+\p{L}{2,}/u.test(rs[0].text)) ||
        formulas.some(
          (rs) =>
            rs.length !== 1 ||
            !/[A-Za-z]/u.test(rs[0].text) ||
            rs[0].fonts.some((f) => /\p{L}{3,}/u.test(f.text))
        )
      )
        continue
      if (
        stubs.some(
          (rs) => Math.abs(rs[0].first.rect[0] - stubs[0][0].first.rect[0]) > lanes[0].h * 0.15
        )
      )
        continue
      return true
    }
  }
  return false
}

// A complete CI from one native record and the next record's scalar cannot
// share a cell when independent stubs and all numeric lanes repeat the crossing.
// This withdraws only structure reliability; it never repairs rows or claims.
function nativeCrossedPointIntervalRecords(table, inventory, context) {
  try {
    const t = nativeRecoveryOwnValues(table),
      c = nativeRecoveryOwnValues(context)
    if (
      !t ||
      !c ||
      t.parts ||
      t.cropRects ||
      !Number.isSafeInteger(t.page) ||
      t.page < 1 ||
      !Array.isArray(t.grid) ||
      t.grid.length < 4 ||
      !Array.isArray(t.cells) ||
      !rect(t.cropRect)
    )
      return false
    const columns = t.grid[0]?.length,
      native = c.nativeGlyphContext,
      content = c.sourceContent,
      page = c.sourcePage,
      scale = c.viewport?.scale
    if (
      !Number.isSafeInteger(columns) ||
      columns < 4 ||
      columns > 32 ||
      t.grid.some((r) => !Array.isArray(r) || r.length !== columns) ||
      !native ||
      !content ||
      page?.pageNumber !== t.page ||
      !(scale > 0) ||
      !Array.isArray(native.content?.items) ||
      !Array.isArray(content.items) ||
      native.content.items.length !== content.items.length ||
      !Array.isArray(inventory)
    )
      return false
    const viewport = c.viewport,
      nativeViewport = native.viewport,
      nativeContent = native.content,
      operators = native.operators,
      glyphBounds = native.glyphBounds,
      graphicsBounds = native.graphicsBounds,
      skippedSpaceGlyphs = native.skippedSpaceGlyphs
    const retained = retainNativeRecoveryInputs(
      [
        table,
        inventory,
        content,
        page,
        {
          content: nativeContent,
          operators,
          glyphBounds,
          graphicsBounds,
          viewport: nativeViewport,
          skippedSpaceGlyphs
        }
      ],
      viewport,
      nativeViewport
    )
    const current = () =>
      retained?.() &&
      context.sourceContent === content &&
      context.sourcePage === page &&
      context.nativeGlyphContext === native &&
      context.viewport === viewport &&
      native.content === nativeContent &&
      native.operators === operators &&
      native.glyphBounds === glyphBounds &&
      native.graphicsBounds === graphicsBounds &&
      native.viewport === nativeViewport &&
      native.skippedSpaceGlyphs === skippedSpaceGlyphs
    if (!retained) return false
    const forward = new Map(),
      backward = new Map()
    for (let i = 0; i < content.items.length; i++) {
      const a = content.items[i],
        b = native.content.items[i]
      if (
        !['str', 'width', 'height', 'dir', 'hasEOL'].every((k) => a[k] === b[k]) ||
        !sameNumbers(a.transform, b.transform) ||
        JSON.stringify(content.styles?.[a.fontName]) !==
          JSON.stringify(native.content.styles?.[b.fontName]) ||
        (forward.has(a.fontName) && forward.get(a.fontName) !== b.fontName) ||
        (backward.has(b.fontName) && backward.get(b.fontName) !== a.fontName)
      )
        return false
      forward.set(a.fontName, b.fontName)
      backward.set(b.fontName, a.fontName)
    }
    const fonts = new Map(),
      counts = new Map(),
      owners = new Map(),
      cells = new Map()
    for (const f of inventory)
      if (f.sourceItem) {
        const k = key(f.sourceItem)
        fonts.set(k, f)
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
    for (const cell of t.cells) {
      if (
        !Number.isSafeInteger(cell.row) ||
        !Number.isSafeInteger(cell.column) ||
        cell.row < 0 ||
        cell.row >= t.grid.length ||
        cell.column < 0 ||
        cell.column >= columns ||
        cells.has(cell.row + ':' + cell.column)
      )
        return false
      cells.set(cell.row + ':' + cell.column, cell)
      for (const o of cell.sourceItems ?? []) owners.set(key(o), (owners.get(key(o)) ?? 0) + 1)
    }
    const at = (r, col) => {
      const cell = cells.get(r + ':' + col)
      if (
        !cell ||
        cell.rowSpan !== 1 ||
        cell.colSpan !== 1 ||
        cell.sourceSegments?.length ||
        !cell.sourceItems?.length ||
        cell.sourceItems.length !== cell.sourceRects?.length ||
        compact(cell.text) !== compact(cell.sourceItems.map((o) => o.text).join(''))
      )
        return
      const list = cell.sourceItems.map((o, i) => {
        const f = fonts.get(key(o)),
          raw = content.items[o.index],
          style = content.styles?.[raw?.fontName]
        if (
          o.pageNumber !== t.page ||
          !Number.isSafeInteger(o.index) ||
          o.index < 0 ||
          counts.get(key(o)) !== 1 ||
          owners.get(key(o)) !== 1 ||
          !f ||
          f.text !== o.text ||
          f.sourceItem.text !== o.text ||
          raw?.str !== o.text ||
          raw.sourceItem?.pageNumber !== t.page ||
          raw.sourceItem.index !== o.index ||
          raw.sourceItem.text !== o.text ||
          !f.horizontal ||
          !Number.isFinite(f.baseline) ||
          !(f.height > 0) ||
          !(f.fontAscent > 0) ||
          !(f.fontDescent <= 0) ||
          !Number.isFinite(f.fontDescent) ||
          style?.vertical !== false ||
          style.ascent !== f.fontAscent ||
          style.descent !== f.fontDescent ||
          !rect(f.rect) ||
          f.rect[0] >= f.rect[2] ||
          f.rect[1] >= f.rect[3] ||
          !sameNumbers(f.rect, cell.sourceRects[i]) ||
          f.rect.some((v, j) => (j < 2 ? v < t.cropRect[j] : v > t.cropRect[j]))
        )
          return
        return f
      })
      return list.every(Boolean) ? list : undefined
    }
    const number = '[+−-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)',
      scalar = new RegExp('^' + number + '$', 'u'),
      interval = new RegExp('^\\[' + number + ',\\s*' + number + '\\]$', 'u'),
      eq = (a, b) => Math.abs(a - b) < 1e-6
    for (let row = 2; row + 1 < t.grid.length; row++) {
      const stubs = [at(row - 1, 0), at(row, 0), at(row + 1, 0)]
      if (stubs.some((s) => !s || s.some((f) => scalar.test(f.text) || interval.test(f.text))))
        continue
      const stubY = stubs.map((s) => s[0].baseline)
      if (stubs.some((s, i) => s.some((f) => !eq(f.baseline, stubY[i])))) continue
      const selected = stubs.flat(),
        lanes = []
      let baselines,
        valid = true
      for (let col = 1; col < columns; col++) {
        const previous = at(row - 1, col),
          first = at(row, col),
          second = at(row + 1, col)
        if (
          !previous ||
          previous.length !== 1 ||
          !scalar.test(previous[0].text) ||
          !first ||
          first.length !== 2 ||
          !second ||
          second.length !== 2
        ) {
          valid = false
          break
        }
        const a = [...first].sort((a, b) => a.baseline - b.baseline),
          b = [...second].sort((a, b) => a.baseline - b.baseline),
          record = [previous[0], a[0], a[1], b[0], b[1]],
          ys = record.map((f) => f.baseline),
          h = Math.max(...record.map((f) => f.height))
        if (
          !interval.test(a[0].text) ||
          !scalar.test(a[1].text) ||
          !interval.test(b[0].text) ||
          !scalar.test(b[1].text) ||
          !(
            ys[0] < stubY[0] &&
            stubY[0] < ys[1] &&
            ys[1] < ys[2] &&
            ys[2] < stubY[1] &&
            stubY[1] < ys[3] &&
            ys[3] < ys[4] &&
            ys[4] < stubY[2]
          ) ||
          ys.slice(1).some((y, i) => y - ys[i] < h * 0.5 || y - ys[i] > h * 2) ||
          (baselines && ys.some((y, i) => !eq(y, baselines[i])))
        ) {
          valid = false
          break
        }
        baselines ??= ys
        const left = Math.min(...record.map((f) => f.rect[0])),
          right = Math.max(...record.map((f) => f.rect[2]))
        if (
          record.some((f) => Math.abs((f.rect[0] + f.rect[2]) / 2 - (left + right) / 2) > h) ||
          (lanes.length && left <= lanes.at(-1)[1])
        ) {
          valid = false
          break
        }
        lanes.push([left, right])
        selected.push(...record)
      }
      if (!valid || stubs.some((s) => s.some((f) => f.rect[2] >= lanes[0][0]))) continue
      const nativeNames = new Set(
        selected.map((f) => forward.get(content.items[f.sourceItem.index].fontName))
      )
      if (nativeNames.size !== 1 || nativeNames.has(undefined) || selected.length > 64) continue
      // Reuse the existing complete native glyph/font/current bridge for a bounded
      // mathematical relation spanning cells, not a new public font-name assertion.
      const tokens = native.content.items
          .filter((i) => i.str?.trim())
          .map((i) => tableTextToken(i, native.viewport, 0)),
        packet = nativeFractionInkPacket(
          page,
          tokens,
          native,
          selected.map((f) => f.sourceItem)
        )
      if (
        !packet ||
        !selected.every((f) => {
          const records = packet.records.filter((r) => r.index === f.sourceItem.index)
          return (
            records.length === 1 &&
            records[0].r.fontName === [...nativeNames][0] &&
            records[0].r.str === f.text &&
            records[0].part.length > 0
          )
        })
      )
        continue
      if (current()) return true
    }
    return false
  } catch {
    return false
  }
}
