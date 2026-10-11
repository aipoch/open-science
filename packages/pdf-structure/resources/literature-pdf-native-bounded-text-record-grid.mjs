/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import {
  hasUniqueRecordTokens,
  readSourceRow,
  groupSourceRowsWithScripts
} from './literature-pdf-source-records.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeWhitespaceGaps } from './literature-pdf-symbol-text.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { proveNativeCompleteRuledSourcePacket } from './literature-pdf-native-leaf-record-repair.mjs'

const finiteItem = (i) =>
  i.horizontal !== false &&
  Number.isFinite(i.baseline) &&
  Number.isFinite(i.height) &&
  i.height > 0 &&
  i.rect?.length === 4 &&
  i.rect.every(Number.isFinite) &&
  i.rect[2] > i.rect[0] &&
  i.rect[3] > i.rect[1]
const pageNumber = (table) => Number(/^page-(\d+)-/.exec(table.id ?? '')?.[1])
const eq = (a, b) => Math.abs(a - b) < 0.05

// Source indices describe native drawing order, not model row ownership. They
// become a record witness only after unchanged whole fonts and every glyph in
// their actual visible, dependency-bound TJ packets have been accounted for.
function ordinarySourcePrograms(fonts, context, p) {
  const { operators: ops, viewport, sourceContent } = context ?? {}
  if (
    !ops ||
    !Array.isArray(ops.fnArray) ||
    !Array.isArray(ops.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length ||
    !viewport ||
    viewport.rotation !== 0 ||
    !sourceContent?.items ||
    !Array.isArray(sourceContent.items) ||
    !Array.isArray(viewport.transform) ||
    viewport.transform.length !== 6 ||
    !viewport.transform.every(Number.isFinite)
  )
    return
  const same = (a, b) => a?.length === b?.length && a.every((v, n) => Math.abs(v - b[n]) < 0.02)
  const compact = (s) => s.replace(/\s/gu, '')
  const source = new Map()
  for (const f of fonts) {
    const origin = f.sourceItem,
      i = sourceContent.items[origin?.index]
    if (
      !finiteItem(f) ||
      f.horizontal !== true ||
      Math.abs(f.baseline - f.rect[3]) > 0.02 ||
      Math.abs(f.height - (f.rect[3] - f.rect[1])) > 0.02 ||
      origin?.pageNumber !== p ||
      !Number.isSafeInteger(origin.index) ||
      origin.index < 0 ||
      source.has(origin.index) ||
      typeof origin.text !== 'string' ||
      !i ||
      !('str' in i) ||
      i.str !== origin.text ||
      i.str !== f.text ||
      typeof i.fontName !== 'string' ||
      !Array.isArray(i.transform) ||
      i.transform.length !== 6 ||
      !i.transform.every(Number.isFinite) ||
      i.transform[0] <= 0 ||
      i.transform[3] <= 0 ||
      i.transform[1] !== 0 ||
      i.transform[2] !== 0
    )
      return
    const original = tableTextToken(i, viewport, 0)
    if (
      !same(original.rect, f.rect) ||
      Math.abs(original.baseline - f.baseline) > 0.02 ||
      Math.abs(original.height - f.height) > 0.02
    )
      return
    source.set(origin.index, i)
  }
  let runs
  try {
    runs = nativeWhitespaceGaps(sourceContent, ops, viewport)
  } catch {
    return
  }
  const programs = new Map()
  for (const f of fonts) {
    const matched = runs.filter((r) => r.text === f.text && same(r.rect, f.rect))
    if (matched.length !== 1) return
    const r = matched[0]
    if (
      Math.abs(r.baseline - f.baseline) > 0.02 ||
      Math.abs(r.height - f.height) > 0.02 ||
      !Array.isArray(r.literalGlyphs) ||
      r.literalGlyphs.some((g) => typeof g !== 'string') ||
      compact(r.literalGlyphs.join('')) !== compact(f.text) ||
      !Array.isArray(r.glyphRuns) ||
      r.glyphRuns.length !== [...compact(f.text)].length ||
      new Set(r.glyphRuns).size !== 1 ||
      r.glyphRuns.some((n) => !Number.isInteger(n) || n < 0 || ops.fnArray[n] !== OPS.showText)
    )
      return
    const index = r.glyphRuns[0],
      group = programs.get(index) ?? []
    group.push(f)
    programs.set(index, group)
  }
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
    ].map((n) => OPS[n])
  )
  const rawLiteral = []
  const dependencies = new Set(),
    stack = []
  let font,
    fill = '#000000',
    stroke = '#000000'
  for (let n = 0; n < ops.fnArray.length; n++) {
    const op = ops.fnArray[n],
      a = ops.argsArray[n]
    if (!allowed.has(op)) return
    if (op === OPS.showText) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some((g) =>
          typeof g === 'number' ? !Number.isFinite(g) : !g || typeof g.unicode !== 'string'
        )
      )
        return
      rawLiteral.push(
        a[0]
          .filter((g) => typeof g === 'object')
          .map((g) => compact(g.unicode))
          .join('')
      )
    }
    if (op === OPS.save) stack.push({ font, fill, stroke })
    else if (op === OPS.restore) {
      const state = stack.pop()
      if (!state) return
      ;({ font, fill, stroke } = state)
    } else if (op === OPS.dependency) {
      if (!Array.isArray(a) || a.some((v) => typeof v !== 'string')) return
      a.forEach((v) => dependencies.add(v))
    } else if (op === OPS.setFont) {
      if (
        !Array.isArray(a) ||
        a.length !== 2 ||
        !dependencies.has(a[0]) ||
        !Number.isFinite(a[1]) ||
        a[1] <= 0
      )
        return
      font = a[0]
    } else if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        typeof a[0] !== 'string' ||
        !/^#[0-9a-f]{6}$/iu.test(a[0])
      )
        return
      if (op === OPS.setFillRGBColor) fill = a[0].toLowerCase()
      else stroke = a[0].toLowerCase()
    } else if (op === OPS.constructPath) {
      // The new family has ordinary stroked rules; clipping, alpha and filled
      // or image/form paint are outside this proof rather than ignored.
      if (
        a?.[0] !== OPS.stroke ||
        stroke === '#ffffff' ||
        !Array.isArray(a[1]) ||
        a[1].some((value) => {
          const path = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : []
          return (
            path.length !== 6 ||
            !path.every(Number.isFinite) ||
            path[0] !== 0 ||
            path[3] !== 1 ||
            (path[1] !== path[4] && path[2] !== path[5])
          )
        })
      )
        return
    } else if (op === OPS.transform || op === OPS.setTextMatrix) {
      const value = op === OPS.setTextMatrix && a?.length === 1 ? a[0] : a
      const matrix = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : []
      if (
        matrix.length !== 6 ||
        !matrix.every(Number.isFinite) ||
        matrix[0] <= 0 ||
        matrix[3] <= 0 ||
        matrix[1] !== 0 ||
        matrix[2] !== 0
      )
        return
    } else if (op === OPS.moveText) {
      if (!Array.isArray(a) || a.length !== 2 || !a.every(Number.isFinite)) return
    } else if (op === OPS.showText && programs.has(n)) {
      const raw = a?.[0],
        group = programs.get(n).sort((x, y) => x.sourceItem.index - y.sourceItem.index)
      if (
        fill === '#ffffff' ||
        !dependencies.has(font) ||
        !Array.isArray(raw) ||
        group.some((f) => source.get(f.sourceItem.index).fontName !== font) ||
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
        raw
          .filter((g) => g && typeof g === 'object')
          .map((g) => compact(g.unicode))
          .join('') !== group.map((f) => compact(f.text)).join('')
      )
        return
    }
  }
  return (
    stack.length === 0 &&
    rawLiteral.join('') ===
      sourceContent.items
        .filter((i) => 'str' in i)
        .map((i) => compact(i.str))
        .join('')
  )
}

function sourcePaintFits(fonts, context, crop) {
  const bottoms = []
  if (
    !fonts.every((f) => {
      const original = context.sourceContent.items[f.sourceItem.index],
        style = context.sourceContent.styles?.[original.fontName]
      if (
        !style ||
        style.vertical !== false ||
        !Number.isFinite(style.ascent) ||
        style.ascent < 0 ||
        style.ascent > 1 ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        style.descent < -1
      )
        return false
      // Some standard-font headers expose zero metrics. A whole em below their
      // baseline is a conservative envelope, never an assertion of zero ink.
      const bottom =
        f.baseline + f.height * (style.ascent === 0 && style.descent === 0 ? 1 : -style.descent)
      bottoms.push(bottom)
      return f.rect[1] >= crop[1]
    })
  )
    return false
  const bottom = Math.max(crop[3], ...bottoms)
  if (bottom > context.viewport.height) return false
  const owned = new Set(fonts.map((f) => f.sourceItem.index))
  if (
    context.sourceContent.items.some((i, n) => {
      if (!('str' in i) || !i.str.trim() || owned.has(n)) return false
      const rect = tableTextToken(i, context.viewport, 0).rect
      return rect[0] < crop[2] && rect[2] > crop[0] && rect[1] < bottom && rect[3] > crop[1]
    })
  )
    return false
  if (bottom > crop[3]) {
    const ink = new Map()
    collectTableRules(context.operators, context.viewport, ink)
    if (
      [...ink.values()].some(
        (r) => r[0] < crop[2] && r[2] > crop[0] && r[1] < bottom && r[3] > crop[3]
      )
    )
      return false
  }
  crop[3] = bottom
  return true
}

function sourceOrderedProseRecords(table, items, captions, rules, context) {
  const crop = table.cropRect,
    p = pageNumber(table)
  if (!context || !Number.isInteger(p) || !crop?.every(Number.isFinite) || table.readingRotation)
    return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect?.[0] < crop[2] &&
      i.rect?.[2] > crop[0] &&
      i.rect?.[1] < crop[3] &&
      i.rect?.[3] > crop[1]
  )
  if (!near.length || near.some((i) => !finiteItem(i))) return
  const em = near.map((i) => i.height).sort((a, b) => a - b)[near.length >> 1]
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em * 1.5 &&
        Math.abs(r[2] - crop[2]) < em * 1.5
    )
    .sort((a, b) => a[1] - b[1])
  if (full.length !== 3 || full.some((r) => !eq(r[0], full[0][0]) || !eq(r[2], full[0][2]))) return
  const [opening, divider, closing] = full
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect?.[0] < opening[2] &&
      i.rect?.[2] > opening[0] &&
      i.rect?.[1] < closing[1] &&
      i.rect?.[3] > opening[1]
  )
  if (
    !source.length ||
    source.some(
      (i) =>
        !finiteItem(i) ||
        Math.abs(i.height - em) > em * 0.04 ||
        i.rect[0] < opening[0] - em * 0.2 ||
        i.rect[2] > opening[2] + em * 0.2 ||
        i.rect[1] < opening[1] - em * 0.2 ||
        i.rect[3] > closing[1]
    )
  )
    return
  const originals = context.sourceContent?.items
    .filter((i) => 'str' in i && i.str.trim())
    .map((i) => tableTextToken(i, context.viewport, 0))
    .filter(
      (i) =>
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[1] < closing[1] &&
        i.rect[3] > opening[1]
    )
  if (
    !originals ||
    originals.length !== source.length ||
    originals.some(
      (i) =>
        source.filter(
          (f) =>
            f.sourceItem?.index === i.sourceItem?.index &&
            f.text === i.text &&
            f.rect.every((v, n) => Math.abs(v - i.rect[n]) < 0.02)
        ).length !== 1
    )
  )
    return
  const projections = []
  for (const i of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
    const prior = projections.at(-1)
    if (prior && i.rect[0] - prior[1] < em * 0.3) prior[1] = Math.max(prior[1], i.rect[2])
    else projections.push([i.rect[0], i.rect[2]])
  }
  if (![2, 4, 6].includes(projections.length)) return
  const cuts = [
    Math.min(opening[0], projections[0][0]),
    ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
    Math.max(opening[2], projections.at(-1)[1])
  ]
  const lane = (i) => cuts.slice(1).findIndex((x, n) => i.rect[0] >= cuts[n] && i.rect[2] <= x)
  if (source.some((i) => lane(i) < 0)) return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  const labels = readSourceRow(header, cuts)
  const firstHeader = header.filter((i) => lane(i) === 0).sort((a, b) => a.rect[0] - b.rect[0])
  // Several unchanged whole fonts can print one header face. This additional
  // family requires complete raw pen/paint closure, including foreign page TJ;
  // geometry alone must not relax the existing single-font header proof.
  const compoundHeader =
    projections.length === 4 &&
    [2, 3].includes(firstHeader.length) &&
    header.length === firstHeader.length + 3 &&
    [1, 2, 3].every((c) => header.filter((i) => lane(i) === c).length === 1) &&
    firstHeader.slice(1).every((i, n) => {
      const gap = i.rect[0] - firstHeader[n].rect[2]
      return gap >= -0.02 && gap < em * 0.3
    }) &&
    proveNativeCompleteRuledSourcePacket(source, rules, context, [
      opening[0],
      opening[1],
      opening[2],
      closing[1]
    ])
  const paired =
    projections.length === 4 &&
    header.length === 2 &&
    labels &&
    /\p{L}/u.test(labels[0]) &&
    !labels[1] &&
    /\p{L}/u.test(labels[2]) &&
    !labels[3]
  if (
    header.length + body.length !== source.length ||
    (!paired &&
      ((!compoundHeader && header.length !== projections.length) ||
        source.some((i) => i.rect[1] < opening[1]))) ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > 0.02) ||
    (!paired && !labels?.every((v) => /\p{L}/u.test(v)))
  )
    return
  const titles = captions.filter(
    (c) =>
      c.page === p &&
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect?.every(Number.isFinite) &&
      c.rect[0] < opening[2] &&
      c.rect[2] > opening[0] &&
      ((c.rect[3] < opening[1] && opening[1] - c.rect[3] < em * 4) ||
        (paired && c.rect[1] > closing[1] && c.rect[1] - closing[1] < em * 4))
  )
  if (titles.length !== 1) return
  const caption = titles[0],
    captionFonts = context.sourceContent?.items
      .filter((i) => 'str' in i && i.str.trim())
      .map((i) => tableTextToken(i, context.viewport, 0))
      .filter(
        (i) =>
          i.rect[0] < caption.rect[2] &&
          i.rect[2] > caption.rect[0] &&
          i.rect[1] < caption.rect[3] &&
          i.rect[3] > caption.rect[1]
      )
  if (
    !captionFonts?.length ||
    captionFonts.some((i) =>
      i.rect.some((v, n) => (n < 2 ? v < caption.rect[n] - 0.02 : v > caption.rect[n] + 0.02))
    ) ||
    captionFonts
      .map((i) => i.text)
      .join('')
      .replace(/\s/gu, '') !== caption.lines.join('').replace(/\s/gu, '')
  )
    return
  if (!ordinarySourcePrograms([...source, ...captionFonts], context, p)) return
  // Rules are re-derived from this same raw program, never trusted from a
  // stale model witness. Their native stroke bounds must include each edge.
  const painted = new Map(),
    native = collectTableRules(context.operators, context.viewport, painted)
  if (
    full.some(
      (r) =>
        native.filter((n) => n.every((v, k) => Math.abs(v - r[k]) < 0.02)).length !== 1 ||
        !painted.has(native.find((n) => n.every((v, k) => Math.abs(v - r[k]) < 0.02)).join(','))
    )
  )
    return
  const ink = full.map((r) =>
    painted.get(native.find((n) => n.every((v, k) => Math.abs(v - r[k]) < 0.02)).join(','))
  )
  if (ink.some((r) => !r?.every(Number.isFinite) || r[0] > opening[0] || r[2] < opening[2])) return
  const cropRect = [
    Math.min(cuts[0], ...ink.map((r) => r[0])),
    Math.min(ink[0][1], ...source.map((i) => i.rect[1])),
    Math.max(cuts.at(-1), ...ink.map((r) => r[2])),
    ink[2][3]
  ]
  if (cropRect[1] < caption.rect[3] && cropRect[3] > caption.rect[1]) return
  if (!sourcePaintFits(source, context, cropRect)) return
  const records = []
  let previous = -1,
    trailing = false
  for (const i of [...body].sort((a, b) => a.sourceItem.index - b.sourceItem.index)) {
    const c = lane(i)
    if (trailing && c < 2) return
    if (paired && c === 2 && previous === 3) {
      if (trailing || records.length < 2) return
      trailing = true
      records.push([])
      previous = 1
    }
    if (c === 0 && previous === cuts.length - 2) {
      records.push([])
      previous = -1
    }
    if (!records.length) {
      if (c !== 0) return
      records.push([])
    }
    if (c < previous || c > previous + 1) return
    records.at(-1).push(i)
    previous = c
  }
  if (
    previous !== cuts.length - 2 ||
    records.length < 3 ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  let wrapped = 0
  for (const record of records) {
    const starts = []
    for (let c = 0; c < projections.length; c++) {
      const field = record
        .filter((i) => lane(i) === c)
        .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
      if (!field.length) {
        if (paired && trailing && record === records.at(-1) && c < 2) continue
        return
      }
      if (
        paired &&
        (c % 2
          ? field.length !== 1 || !/^[-−+]?\d+(?:\.\d+)?$/u.test(field[0].text)
          : !field.some((i) => /\p{L}/u.test(i.text)))
      )
        return
      if (
        projections.length === 6 &&
        c < 4 &&
        (field.length !== 1 ||
          (c ? !/^\d+(?:\.\d+)?$/u.test(field[0].text) : !/\p{L}/u.test(field[0].text)))
      )
        return
      const lines = [...new Set(field.map((i) => Math.round(i.baseline / 0.02)))].sort(
        (a, b) => a - b
      )
      starts.push(field[0].baseline)
      if (lines.length > 1) wrapped++
      if (
        lines
          .slice(1)
          .some((v, n) => (v - lines[n]) * 0.02 < em * 0.8 || (v - lines[n]) * 0.02 > em * 1.6)
      )
        return
    }
    if (starts.some((y) => Math.abs(y - starts[0]) > 0.02)) return
  }
  if (!wrapped) return
  const bounds = records.map((r) => [
    Math.min(...r.map((i) => i.rect[1])),
    Math.max(...r.map((i) => i.rect[3]))
  ])
  if (bounds.some((r, n) => n && r[0] - bounds[n - 1][1] < em * 0.04)) return
  const edges = [
    cropRect[1],
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    closing[1]
  ]
  return {
    cropRect,
    rows: edges.slice(1).map((y, n) => [cuts[0], edges[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, closing[1]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Repeated native wall packets delimit two independent field/value pairs.
// A double center wall is an empty gutter, not a fifth semantic column. The
// existing script grouper retains literal raised carriers beside their anchors.
function closedPairedRecords(table, items, captions, rules, context) {
  const crop = table.cropRect,
    p = pageNumber(table)
  if (!context || !Number.isInteger(p) || !crop?.every(Number.isFinite) || table.readingRotation)
    return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect?.[0] < crop[2] &&
      i.rect?.[2] > crop[0] &&
      i.rect?.[1] < crop[3] &&
      i.rect?.[3] > crop[1]
  )
  if (!near.length || near.some((i) => !finiteItem(i))) return
  const em = near.map((i) => i.height).sort((a, b) => a - b)[near.length >> 1]
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  if (full.length !== 3 || full.some((r) => !eq(r[0], full[0][0]) || !eq(r[2], full[0][2]))) return
  const [opening, divider, closing] = full
  const walls = rules
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        r[1] > opening[1] &&
        r[3] < closing[1]
    )
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const packets = []
  for (const wall of walls) {
    const previous = packets.at(-1)
    if (previous && eq(previous[0][1], wall[1]) && eq(previous[0][3], wall[3])) previous.push(wall)
    else packets.push([wall])
  }
  if (packets.length < 5 || packets.length > 9 || packets.some((g) => g.length !== 8)) return
  const groups = []
  for (const wall of packets[0]) {
    const previous = groups.at(-1)
    if (previous && wall[0] - previous.at(-1) < em * 0.3) previous.push(wall[0])
    else groups.push([wall[0]])
  }
  if (groups.length !== 5 || groups.some((g, n) => g.length !== ([0, 2, 4].includes(n) ? 2 : 1)))
    return
  const cuts = groups.map((g) => g.reduce((a, b) => a + b) / g.length)
  if (cuts.slice(1).some((x, n) => x - cuts[n] < em * 3)) return
  if (
    packets.some(
      (g, n) =>
        g.some((r, c) => !eq(r[0], packets[0][c][0])) ||
        g[0][3] - g[0][1] < em ||
        g[0][3] - g[0][1] > em * 1.4 ||
        (n && (g[0][1] - packets[n - 1][0][3] < 0 || g[0][1] - packets[n - 1][0][3] > em * 0.1))
    )
  )
    return
  if (
    packets[0][0][1] - opening[1] > em * 0.1 ||
    Math.abs(divider[1] - (packets[0][0][3] + packets[1][0][1]) / 2) > 0.02 ||
    closing[1] - packets.at(-1)[0][3] > em * 0.1
  )
    return
  const original = context.sourceContent?.items
    .filter((i) => 'str' in i && i.str.trim())
    .map((i) => tableTextToken(i, context.viewport, 0))
    .filter(
      (i) =>
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[1] < closing[1] &&
        i.rect[3] > opening[1]
    )
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect?.[0] < opening[2] &&
      i.rect?.[2] > opening[0] &&
      i.rect?.[1] < closing[1] &&
      i.rect?.[3] > opening[1]
  )
  if (
    !original?.length ||
    original.length !== source.length ||
    source.some(
      (i) =>
        !finiteItem(i) ||
        i.rect[0] < cuts[0] ||
        i.rect[2] > cuts.at(-1) ||
        i.rect[1] < opening[1] - em * 0.2 ||
        i.rect[3] > closing[1]
    ) ||
    original.some(
      (i) =>
        source.filter(
          (f) =>
            f.sourceItem?.index === i.sourceItem?.index &&
            f.text === i.text &&
            f.rect.every((v, n) => Math.abs(v - i.rect[n]) < 0.02)
        ).length !== 1
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  const heads = readSourceRow(header, cuts)
  if (
    header.length !== 2 ||
    !heads ||
    heads[0] ||
    heads[2] ||
    !heads[1] ||
    !heads[3] ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > 0.02)
  )
    return
  const records = groupSourceRowsWithScripts(
    [...body].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    em,
    0.1
  )
  if (
    !records ||
    records.length !== packets.length - 1 ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  let trailing = 0
  for (let n = 0; n < records.length; n++) {
    const record = records[n],
      values = readSourceRow(record, cuts),
      mains = record.filter((i) => i.height > em * 0.8),
      wall = packets[n + 1][0]
    if (
      !values ||
      !mains.length ||
      mains.some(
        (i) =>
          Math.abs(i.height - em) > em * 0.04 ||
          Math.abs(i.baseline - mains[0].baseline) > 0.02 ||
          i.baseline <= wall[1] ||
          i.baseline >= wall[3] ||
          i.rect[1] < wall[1] - em * 0.2
      )
    )
      return
    if (!values[2] || !values[3] || !/[\p{L}]/u.test(values[2])) return
    if (!values[0] && !values[1]) {
      if (n !== records.length - 1) return
      trailing++
    } else if (!values[0] || !values[1] || !/[\p{L}]/u.test(values[0])) return
  }
  if (trailing > 1) return
  const titles = captions.filter(
    (c) =>
      c.page === p &&
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect?.every(Number.isFinite) &&
      c.rect[0] < opening[2] &&
      c.rect[2] > opening[0] &&
      c.rect[3] < opening[1] &&
      opening[1] - c.rect[3] < em * 4
  )
  if (titles.length !== 1) return
  const caption = titles[0],
    captionFonts = context.sourceContent.items
      .filter((i) => 'str' in i && i.str.trim())
      .map((i) => tableTextToken(i, context.viewport, 0))
      .filter(
        (i) =>
          i.rect[0] < caption.rect[2] &&
          i.rect[2] > caption.rect[0] &&
          i.rect[1] < caption.rect[3] &&
          i.rect[3] > caption.rect[1]
      )
  if (
    !captionFonts.length ||
    captionFonts.some((i) =>
      i.rect.some((v, n) => (n < 2 ? v < caption.rect[n] - 0.02 : v > caption.rect[n] + 0.02))
    ) ||
    captionFonts
      .map((i) => i.text)
      .join('')
      .replace(/\s/gu, '') !== caption.lines.join('').replace(/\s/gu, '')
  )
    return
  if (!ordinarySourcePrograms([...source, ...captionFonts], context, p)) return
  const painted = new Map(),
    native = collectTableRules(context.operators, context.viewport, painted),
    edges = [...full, ...walls],
    ink = []
  for (const edge of edges) {
    const match = native.filter((r) => r.every((v, n) => Math.abs(v - edge[n]) < 0.02))
    if (match.length !== 1 || !painted.get(match[0].join(','))?.every(Number.isFinite)) return
    ink.push(painted.get(match[0].join(',')))
  }
  const cropRect = [
    Math.min(opening[0], ...ink.map((r) => r[0])),
    Math.min(...source.map((i) => i.rect[1]), ...ink.map((r) => r[1])),
    Math.max(opening[2], ...ink.map((r) => r[2])),
    Math.max(...ink.map((r) => r[3]))
  ]
  if (cropRect[1] <= caption.rect[3]) return
  if (!sourcePaintFits(source, context, cropRect)) return
  const ys = [
    cropRect[1],
    divider[1],
    ...packets.slice(2).map((g, n) => (packets[n + 1][0][3] + g[0][1]) / 2),
    cropRect[3]
  ]
  return {
    cropRect,
    rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], cropRect[1], x, cropRect[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Three closed native lanes and repeated, separated middle-column paragraphs
// bound prose records. Full source ink proves the gutters independently of
// model columns; no paragraph can be cut into another model row.
export function recoverNativeProseLaneRecords(table, items, captions, rules, context) {
  const paired = closedPairedRecords(table, items, captions, rules, context)
  if (paired) return paired
  const sourceOrdered = sourceOrderedProseRecords(table, items, captions, rules, context)
  if (sourceOrdered) return sourceOrdered
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        finiteItem(i) &&
        i.text.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    ),
    heights = near.map((i) => i.height).sort((a, b) => a - b),
    em = heights[heights.length >> 1]
  if (!(em > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  if (full.length !== 3 || full.some((r) => !eq(r[0], full[0][0]) || !eq(r[2], full[0][2]))) return
  const [opening, divider, closing] = full,
    source = items.filter(
      (i) =>
        i.text.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[3] > opening[1] &&
        i.rect[1] < closing[1]
    )
  if (
    source.some(
      (i) =>
        !finiteItem(i) ||
        Math.abs(i.height - em) > em * 0.05 ||
        i.rect[0] < opening[0] - 0.02 ||
        i.rect[2] > opening[2] + 0.02 ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < em * 8) ||
          (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < em * 8))
    ).length !== 1
  )
    return
  const projections = []
  for (const i of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
    const last = projections.at(-1)
    if (last && i.rect[0] - last[1] < em * 0.4) last[1] = Math.max(last[1], i.rect[2])
    else projections.push([i.rect[0], i.rect[2]])
  }
  if (projections.length !== 3) return
  const cuts = [
      Math.min(opening[0], projections[0][0]),
      ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
      Math.max(opening[2], projections.at(-1)[1])
    ],
    header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (!readSourceRow(header, cuts, { multiline: true })?.every((v) => /\p{L}/u.test(v))) return
  const physical = []
  for (const i of [...body].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = physical.at(-1)
    if (last && Math.abs(last[0].baseline - i.baseline) < em * 0.05) last.push(i)
    else physical.push([i])
  }
  const values = physical.map((r) => readSourceRow(r, cuts)),
    starts = values.flatMap((v, n) => (v?.[1] && (!n || !values[n - 1]?.[1]) ? [n] : []))
  if (starts.length < 3 || starts[0] !== 0 || values.some((v) => !v)) return
  const records = starts.map((n, k) => physical.slice(n, starts[k + 1] ?? physical.length).flat())
  if (
    records.some((r, k) => {
      const v = readSourceRow(r, cuts, { multiline: true }),
        first = values[starts[k]]
      return (
        !v?.every((s) => /\p{L}/u.test(s)) ||
        !first.every(Boolean) ||
        cuts
          .slice(1)
          .some(
            (x, c) =>
              new Set(
                r
                  .filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x)
                  .map((i) => Math.round(i.baseline / (em * 0.05)))
              ).size < 2
          )
      )
    }) ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const bounds = records.map((r) => [
    Math.min(...r.map((i) => i.rect[1])),
    Math.max(...r.map((i) => i.rect[3]))
  ])
  if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
  const edges = [
    opening[1],
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    closing[1]
  ]
  return {
    cropRect: [cuts[0], opening[1], cuts.at(-1), closing[1]],
    rows: edges.slice(1).map((y, n) => [cuts[0], edges[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, closing[1]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// A measured scalar and its native type token can prove a record start even
// when a reason field wraps once below that start.  The model can place the
// continuation into the following row when the two starts are close; move only
// that one continuation across the already observed row boundary.  This is a
// deliberately narrow repair: it never invents spans, columns, or text.
export function recoverNativeScalarTypeReasonTail({ rows, items, columnRects, rules, repairs }) {
  if (!Array.isArray(rows) || !Array.isArray(items) || columnRects?.length !== 7) return
  const finite = (item) =>
    item?.horizontal !== false &&
    Number.isFinite(item.baseline) &&
    Number.isFinite(item.height) &&
    item.height > 0 &&
    item.rect?.length === 4 &&
    item.rect.every(Number.isFinite) &&
    item.rect[2] > item.rect[0] &&
    item.rect[3] > item.rect[1]
  const source = items.filter((item) => finite(item) && item.text?.trim())
  const heights = source.map((item) => item.height).sort((a, b) => a - b),
    em = heights[Math.floor(heights.length / 2)]
  if (!(em > 0)) return
  const column = (item) => {
    const center = (item.rect[0] + item.rect[2]) / 2
    return columnRects.findIndex(([left, top, right, bottom]) => {
      void top
      void bottom
      return center >= left && center <= right
    })
  }
  const scalar = source.filter((item) => column(item) === 3 && /^\d\.\d{4}$/.test(item.text.trim()))
  if (scalar.length < 4) return
  const anchors = scalar
    .map((number) => {
      const type = source.filter(
        (item) =>
          column(item) === 5 &&
          /^(?:E[12]|M1)$/.test(item.text.trim()) &&
          Math.abs(item.baseline - number.baseline) < em * 0.08
      )
      return type.length === 1 ? { number, type: type[0] } : undefined
    })
    .filter(Boolean)
    .sort((a, b) => a.number.baseline - b.number.baseline)
  if (anchors.length < 4 || new Set(anchors.map((a) => a.number)).size !== anchors.length) return
  const horizontalRuleBetween = (a, b) =>
    rules.some(
      (rule) =>
        rule[1] === rule[3] &&
        rule[1] > a &&
        rule[1] < b &&
        rule[2] - rule[0] >= columnRects.at(-1)[2] - columnRects[0][0]
    )
  for (let n = 0; n < anchors.length - 1; n++) {
    const current = anchors[n],
      next = anchors[n + 1],
      currentRowIndex = rows.findIndex(
        (row) => current.number.rect[1] >= row.rect[1] && current.number.rect[3] <= row.rect[3]
      ),
      nextRowIndex = rows.findIndex(
        (row) => next.number.rect[1] >= row.rect[1] && next.number.rect[3] <= row.rect[3]
      )
    if (currentRowIndex < 1 || nextRowIndex !== currentRowIndex + 1) continue
    const currentRow = rows[currentRowIndex],
      nextRow = rows[nextRowIndex],
      reason = source.filter(
        (item) =>
          column(item) === 6 &&
          item.baseline >= current.number.baseline - em * 0.08 &&
          item.baseline <= current.number.baseline + em * 0.08
      ),
      candidate = source.filter(
        (item) =>
          column(item) === 6 &&
          item.baseline > current.number.baseline + em * 0.8 &&
          item.baseline < next.number.baseline - em * 0.2
      )
    if (!reason.length || !candidate.length) continue
    const baselines = [...new Set(candidate.map((item) => Math.round(item.baseline / (em * 0.08))))]
    if (baselines.length !== 1 || candidate.some((item) => !/\p{L}/u.test(item.text))) continue
    const tailBottom = Math.max(...candidate.map((item) => item.rect[3])),
      tailTop = Math.min(...candidate.map((item) => item.rect[1])),
      nextInkTop = Math.min(
        ...source
          .filter(
            (item) =>
              item.rect[1] > tailBottom &&
              item.baseline >= next.number.baseline - em * 0.08 &&
              item.baseline <= next.number.baseline + em * 0.5
          )
          .map((item) => item.rect[1])
      )
    if (
      !Number.isFinite(nextInkTop) ||
      tailBottom <= currentRow.rect[3] ||
      tailTop >= nextRow.rect[3] ||
      nextInkTop - tailBottom < em * 0.2 ||
      tailTop - reason[0].rect[3] > em * 1.5 ||
      horizontalRuleBetween(currentRow.rect[3], tailBottom) ||
      candidate.some((item) => item.rect[0] < columnRects[6][0] || item.rect[2] > columnRects[6][2])
    )
      continue
    currentRow.rect[3] = tailBottom + em * 0.02
    nextRow.rect[1] = currentRow.rect[3]
    repairs.push('native-scalar-type-reason-tail-recovered')
    return true
  }
  return
}

// An indexed directory has independently printed record starts. Its long
// source field may wrap far beyond the model row, without starting a new row.
// This refines existing candidates only; it does not discover captionless lists.
export function recoverNativeIndexedDirectoryGrid(table, items, rules) {
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        finiteItem(i) &&
        i.text.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.baseline > crop[1] &&
        i.baseline < crop[3]
    ),
    heights = near.map((i) => i.height).sort((a, b) => a - b),
    em = heights[Math.floor(heights.length / 2)]
  if (!(em > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  if (
    ![2, 3].includes(full.length) ||
    full.some((r) => !eq(r[0], full[0][0]) || !eq(r[2], full[0][2]))
  )
    return
  const [opening, divider, closing] = full
  if (divider[1] - opening[1] < em * 0.6 || divider[1] - opening[1] > em * 2.5) return
  let end = closing?.[1] ?? crop[3]
  let source = items.filter(
    (i) =>
      i.text.trim() &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0] &&
      i.rect[3] > opening[1] &&
      i.rect[1] < end
  )
  if (!closing) {
    const p = pageNumber(table),
      footer = items.filter(
        (i) =>
          i.text.trim() === String(p) &&
          i.rect[1] > divider[1] &&
          Math.abs((i.rect[0] + i.rect[2]) / 2 - (opening[0] + opening[2]) / 2) < em * 0.5
      )
    if (
      footer.length !== 1 ||
      source.some((i) => i !== footer[0] && i.rect[3] > footer[0].rect[1] - em * 3)
    )
      return
    source = source.filter((i) => i !== footer[0])
    end = Math.max(...source.map((i) => i.rect[3])) + em * 0.1
    if (
      items.some(
        (i) =>
          i.text.trim() &&
          i !== footer[0] &&
          i.rect[0] < opening[2] &&
          i.rect[2] > opening[0] &&
          i.rect[3] > end
      )
    )
      return
  }
  if (
    source.some(
      (i) =>
        !finiteItem(i) ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > end
    )
  )
    return
  const header = source
      .filter((i) => i.baseline < divider[1])
      .sort((a, b) => a.rect[0] - b.rect[0]),
    body = source.filter((i) => i.baseline > divider[1])
  if (
    header.length !== 3 ||
    header.some(
      (i) => !/\p{L}/u.test(i.text) || Math.abs(i.baseline - header[0].baseline) > em * 0.05
    )
  )
    return
  const rough = [opening[0], ...header.slice(1).map((i) => i.rect[0] - em * 0.01), opening[2]],
    cuts = [opening[0]]
  for (let n = 1; n < 3; n++) {
    const left = source.filter(
        (i) => (i.rect[0] + i.rect[2]) / 2 >= rough[n - 1] && (i.rect[0] + i.rect[2]) / 2 < rough[n]
      ),
      right = source.filter(
        (i) => (i.rect[0] + i.rect[2]) / 2 >= rough[n] && (i.rect[0] + i.rect[2]) / 2 < rough[n + 1]
      ),
      a = Math.max(...left.map((i) => i.rect[2])),
      b = Math.min(...right.map((i) => i.rect[0]))
    if (b - a < em * 0.15) return
    cuts.push((a + b) / 2)
  }
  cuts.push(opening[2])
  const anchors = body.filter((i) => i.rect[2] < cuts[1]).sort((a, b) => a.baseline - b.baseline),
    parsed = anchors.map((i) => /^([A-Za-z]{1,3})(\d{1,4})$/.exec(i.text.trim()))
  if (
    anchors.length < 2 ||
    parsed.some(
      (m, n) =>
        !m || (n && (m[1] !== parsed[0][1] || Number(m[2]) !== Number(parsed[n - 1][2]) + 1))
    )
  )
    return
  const records = anchors.map((a, n) =>
    body.filter(
      (i) =>
        i.baseline >= a.baseline - em * 0.05 &&
        (!anchors[n + 1] || i.baseline < anchors[n + 1].baseline - em * 0.05)
    )
  )
  if (
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    records.some(
      (r, n) =>
        !readSourceRow(r, cuts, { multiline: true })?.every((s) => s.trim()) ||
        r.filter((i) => i.rect[2] < cuts[1]).length !== 1 ||
        r.some((i) => i.rect[0] >= cuts[1] && i.baseline < anchors[n].baseline - em * 0.05)
    )
  )
    return
  const bounds = records.map((r) => [
    Math.min(...r.map((i) => i.rect[1])),
    Math.max(...r.map((i) => i.rect[3]))
  ])
  if (bounds.some((r, n) => n && r[0] - bounds[n - 1][1] < em * 0.04)) return
  const edges = [
    opening[1],
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    end
  ]
  return {
    cropRect: [opening[0], opening[1], opening[2], end],
    rows: edges.slice(1).map((y, n) => [opening[0], edges[n], opening[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, end]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}
const terminalInk = (f, items, p, height) =>
  items
    .filter(
      (i) =>
        i.text?.trim() && i.rect[0] < f.opening[2] && i.rect[2] > f.opening[0] && i.rect[3] > f.end
    )
    .every(
      (i) =>
        finiteItem(i) &&
        i.text.trim() === String(p) &&
        i.rect[1] > height * 0.94 &&
        Math.abs((i.rect[0] + i.rect[2]) / 2 - (f.opening[0] + f.opening[2]) / 2) < f.em * 0.5
    )

function frame(table, items, rules, blankOrdinal = false) {
  const crop = table.cropRect
  if (!crop?.every(Number.isFinite)) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.baseline > crop[1] &&
      i.baseline < crop[3]
  )
  if (!near.length || near.some((i) => !finiteItem(i))) return
  const heights = near.map((i) => i.height).sort((a, b) => a - b)
  const em = heights[Math.floor(heights.length / 2)]
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        r[2] - r[0] >= (crop[2] - crop[0]) * 0.85 &&
        r[2] - r[0] <= (crop[2] - crop[0]) * 1.6
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 2 ||
    full.length > 3 ||
    full.some((r) => !eq(r[0], full[0][0]) || !eq(r[2], full[0][2]))
  )
    return
  const [opening, divider, closing] = full
  if (blankOrdinal && !closing) return
  if (divider[1] - opening[1] < em * 0.6 || divider[1] - opening[1] > em * 2.5) return
  if (closing && closing[1] - divider[1] < em * 3) return
  const end = closing?.[1] ?? crop[3]
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0] &&
      i.rect[1] < end &&
      i.rect[3] > opening[1]
  )
  if (
    source.some(
      (i) =>
        !finiteItem(i) ||
        i.rect[0] < opening[0] - 0.01 ||
        i.rect[2] > opening[2] + 0.01 ||
        i.rect[1] < opening[1] ||
        i.rect[3] > end ||
        Math.abs(i.height - em) > em * 0.04
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1])
  if (
    header.length < 2 ||
    header.length > 3 ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > em * 0.04)
  )
    return
  header.sort((a, b) => a.rect[0] - b.rect[0])
  const body = source.filter((i) => i.baseline > divider[1])
  if (!body.length || header.length + body.length !== source.length) return
  if (
    blankOrdinal &&
    (header.length !== 2 ||
      source.some(
        (i) =>
          i.horizontal !== true ||
          Math.abs(i.baseline - i.rect[3]) > 0.02 ||
          Math.abs(i.rect[3] - i.rect[1] - i.height) > 0.02 ||
          i.sourceItem?.pageNumber !== pageNumber(table) ||
          !Number.isSafeInteger(i.sourceItem?.index) ||
          i.sourceItem.index < 0 ||
          typeof i.sourceItem.text !== 'string' ||
          i.sourceItem.text.replace(/\s/gu, '') !== i.text.replace(/\s/gu, '')
      ) ||
      new Set(source.map((i) => i.sourceItem.index)).size !== source.length ||
      new Set(source.map((i) => i.rect.join(','))).size !== source.length)
  )
    return
  // Flush source header starts only propose lanes. Every complete source
  // envelope must subsequently fit a positive empty gutter between them.
  const rough = [opening[0], ...header.slice(1).map((i) => i.rect[0] - em * 0.01), opening[2]]
  const cuts = [blankOrdinal ? Math.min(opening[0], ...source.map((i) => i.rect[0])) : opening[0]]
  if (blankOrdinal) {
    // A physically blank ordinal header does not invent a third printed label.
    // Complete native envelopes independently establish the narrow number lane
    // and both prose lanes, including every wrapped font and both empty gutters.
    const projections = []
    for (const i of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = projections.at(-1)
      if (last && i.rect[0] - last[1] < em * 0.3) last[1] = Math.max(last[1], i.rect[2])
      else projections.push([i.rect[0], i.rect[2]])
    }
    if (
      projections.length !== 3 ||
      projections[0][1] - projections[0][0] > em * 2 ||
      projections.slice(1).some((r, n) => Math.abs(header[n].rect[0] - r[0]) > em * 0.02) ||
      header.some((i) => !/\p{L}/u.test(i.text))
    )
      return
    cuts.push(...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2))
    const ordinals = body.filter((i) => i.rect[2] <= cuts[1])
    if (
      ordinals.length < 4 ||
      ordinals.some(
        (i) => !/^\d+$/.test(i.text.trim()) || Math.abs(i.rect[2] - ordinals[0].rect[2]) > 0.02
      )
    )
      return
  }
  for (let n = 1; !blankOrdinal && n < header.length; n++) {
    const left = source.filter(
      (i) =>
        (i.rect[0] + i.rect[2]) / 2 < rough[n] &&
        (n === 1 || (i.rect[0] + i.rect[2]) / 2 >= rough[n - 1])
    )
    const right = source.filter(
      (i) =>
        (i.rect[0] + i.rect[2]) / 2 >= rough[n] &&
        (n === header.length - 1 || (i.rect[0] + i.rect[2]) / 2 < rough[n + 1])
    )
    const a = Math.max(...left.map((i) => i.rect[2])),
      b = Math.min(...right.map((i) => i.rect[0]))
    if (b - a < em * 0.3) return
    cuts.push((a + b) / 2)
  }
  cuts.push(blankOrdinal ? Math.max(opening[2], ...source.map((i) => i.rect[2])) : opening[2])
  if (
    source.some(
      (i) =>
        cuts.slice(1).filter((x, n) => i.rect[0] >= cuts[n] - 0.01 && i.rect[2] <= x + 0.01)
          .length !== 1
    )
  )
    return
  const physical = []
  for (const i of body.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = physical.at(-1)
    if (last && Math.abs(last[0].baseline - i.baseline) < em * 0.04) last.push(i)
    else physical.push([i])
  }
  if (physical.length < 3 || physical.length > 80) return
  const gaps = physical.slice(1).map((r, n) => r[0].baseline - physical[n][0].baseline)
  if (
    gaps.some((g) => g < em || g > em * 1.6) ||
    (!blankOrdinal && gaps.some((g) => Math.abs(g - gaps[0]) > em * 0.05))
  )
    return
  if (
    rules.some(
      (r) =>
        r[1] === r[3] &&
        r[2] - r[0] > em * 4 &&
        r[0] > opening[0] + em &&
        r[2] < opening[2] - em &&
        r[1] > divider[1] &&
        r[1] < end
    )
  )
    return
  return {
    crop: blankOrdinal
      ? [opening[0] - 0.5, opening[1] - 0.5, opening[2] + 0.5, closing[1] + 0.5]
      : crop,
    em,
    opening,
    divider,
    closing,
    end,
    source,
    header,
    body,
    cuts,
    physical,
    leading: gaps[0]
  }
}

function formalCaptions(captions, f, p) {
  return captions.filter(
    (c) =>
      c.page === p &&
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[0] < f.opening[2] &&
      c.rect[2] > f.opening[0] &&
      c.rect[3] <= f.opening[1] &&
      f.opening[1] - c.rect[3] < f.em * 3
  )
}

function pairedRecords(f) {
  if (f.header.length !== 2) return
  const records = []
  for (const row of f.physical) {
    const values = readSourceRow(row, f.cuts)
    if (!values) return
    if (values.every((v) => v.trim())) {
      if (row.length !== 2) return
      records.push([...row])
    } else if (values[0].trim() && !values[1].trim()) {
      if (
        !records.length ||
        records.at(-1).length !== 2 ||
        row.length !== 1 ||
        Math.abs(row[0].rect[0] - records.at(-1)[0].rect[0]) > f.em * 0.02 ||
        f.cuts[1] - records.at(-1)[0].rect[2] > f.em * 1.2 ||
        row[0].rect[2] - row[0].rect[0] >=
          (records.at(-1)[0].rect[2] - records.at(-1)[0].rect[0]) * 0.5
      )
        return
      records.at(-1).push(...row)
    } else return
  }
  if (records.length < 3 || !hasUniqueRecordTokens(f.source, [f.header, ...records])) return
  return records
}

function grid(f, records) {
  const crop = [
    Math.min(f.crop[0], f.opening[0] - 0.5),
    f.crop[1],
    Math.max(f.crop[2], f.opening[2] + 0.5),
    f.crop[3]
  ]
  const edges = [crop[1], f.divider[1]]
  for (let n = 1; n < records.length; n++) {
    const a = Math.max(...records[n - 1].map((i) => i.rect[3])),
      b = Math.min(...records[n].map((i) => i.rect[1]))
    if (b - a < f.em * 0.04) return
    edges.push((a + b) / 2)
  }
  edges.push(crop[3])
  return {
    cropRect: crop,
    rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
    columns: f.cuts
      .slice(1)
      .map((x, n) => [
        n ? f.cuts[n] : crop[0],
        crop[1],
        n === f.cuts.length - 2 ? crop[2] : x,
        crop[3]
      ]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(f.source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

export function getNativePairedTextContextDirection(table, tokens, captions, rules, pageHeight) {
  if (!(pageHeight > 0) || !Number.isFinite(pageHeight)) return
  const f = frame(table, tokens, rules)
  if (!f || !pairedRecords(f)) return
  const p = pageNumber(table)
  if (!Number.isInteger(p) || p < 1) return
  const caption = formalCaptions(captions, f, p)
  if (
    !f.closing &&
    caption.length === 1 &&
    terminalInk(f, tokens, p, pageHeight) &&
    Math.max(...f.body.map((i) => i.rect[3])) > pageHeight * 0.85 &&
    f.crop[3] < pageHeight &&
    pageHeight - f.crop[3] < f.em * 9
  )
    return 1
  if (
    f.closing &&
    !caption.length &&
    f.opening[1] < pageHeight * 0.15 &&
    f.closing[1] < pageHeight * 0.4
  )
    return -1
}

export function recoverNativePairedTextRecordGrid(table, tokens, captions, rules, adjacent) {
  if (
    !adjacent?.tokens?.length ||
    !adjacent.rules?.length ||
    !Number.isFinite(adjacent.currentHeight) ||
    !(adjacent.currentHeight > 0)
  )
    return
  const f = frame(table, tokens, rules)
  if (!f) return
  const p = pageNumber(table),
    next = !f.closing
  if (
    getNativePairedTextContextDirection(table, tokens, captions, rules, adjacent.currentHeight) !==
    (next ? 1 : -1)
  )
    return
  if (
    adjacent.pageNumber !== p + (next ? 1 : -1) ||
    !Number.isFinite(adjacent.height) ||
    !(adjacent.height > 0)
  )
    return
  const matchingRules = joinHorizontalTableRules(adjacent.rules)
    .filter((r) => eq(r[0], f.opening[0]) && eq(r[2], f.opening[2]))
    .sort((a, b) => a[1] - b[1])
  const candidates = []
  for (let n = 0; n < matchingRules.length - 1; n++) {
    const opening = matchingRules[n],
      divider = matchingRules[n + 1]
    if (divider[1] - opening[1] < f.em * 0.6 || divider[1] - opening[1] > f.em * 2.5) continue
    const closing = next ? matchingRules[n + 2] : undefined
    const end = closing?.[1] ?? adjacent.height * 0.94
    const candidate = frame(
      {
        cropRect: [opening[0], opening[1], opening[2], end],
        id: `page-${adjacent.pageNumber}-native-proof`
      },
      adjacent.tokens,
      adjacent.rules
    )
    if (
      !candidate ||
      !!candidate.closing !== next ||
      candidate.header.length !== 2 ||
      candidate.header.some(
        (i, k) =>
          i.text !== f.header[k].text ||
          !eq(i.rect[0], f.header[k].rect[0]) ||
          Math.abs(i.height - f.em) > f.em * 0.02
      ) ||
      Math.abs(candidate.leading - f.leading) > f.em * 0.05 ||
      !pairedRecords(candidate) ||
      (!candidate.closing &&
        !terminalInk(candidate, adjacent.tokens, adjacent.pageNumber, adjacent.height))
    )
      continue
    const prior = next ? f : candidate,
      current = next ? candidate : f
    if (
      formalCaptions(
        next ? captions : (adjacent.captions ?? []),
        prior,
        next ? p : adjacent.pageNumber
      ).length !== 1 ||
      formalCaptions(
        next ? (adjacent.captions ?? []) : captions,
        current,
        next ? adjacent.pageNumber : p
      ).length ||
      current.opening[1] > (next ? adjacent.height : adjacent.currentHeight) * 0.15
    )
      continue
    if (
      prior.closing ||
      Math.max(...prior.body.map((i) => i.rect[3])) <
        (next ? adjacent.currentHeight : adjacent.height) * 0.85
    )
      continue
    candidates.push(candidate)
  }
  if (candidates.length !== 1) return
  const recovered = grid(f, pairedRecords(f))
  if (recovered && !next)
    recovered.continuationCaption = formalCaptions(
      adjacent.captions ?? [],
      candidates[0],
      adjacent.pageNumber
    )[0]
  return recovered
}

export function recoverNativePairedTextCaption(table, tokens, captions, rules, adjacent) {
  return recoverNativePairedTextRecordGrid(table, tokens, captions, rules, adjacent)
    ?.continuationCaption
}

export function recoverNativeOrdinalWrappedRecordGrid(table, tokens, captions, rules) {
  // Malformed present page fonts cannot silently disappear through rectangle
  // comparisons before the whole native source owner has been established.
  if (
    tokens.some(
      (i) =>
        i.text?.trim() &&
        (i.rect?.length !== 4 ||
          !i.rect.every(Number.isFinite) ||
          i.rect[2] <= i.rect[0] ||
          i.rect[3] <= i.rect[1] ||
          !Number.isFinite(i.baseline) ||
          !Number.isFinite(i.height) ||
          i.height <= 0)
    )
  )
    return
  let f = frame(table, tokens, rules)
  const legacy =
    f?.closing &&
    f.header.length === 3 &&
    formalCaptions(captions, f, pageNumber(table)).length === 1
  if (!legacy) {
    f = frame(table, tokens, rules, true)
    if (
      !f ||
      formalCaptions(captions, f, pageNumber(table)).length ||
      captions.some(
        (c) =>
          c.page === pageNumber(table) &&
          c.rect[0] < f.opening[2] &&
          c.rect[2] > f.opening[0] &&
          c.rect[1] < f.closing[1] &&
          c.rect[3] > f.opening[1]
      )
    )
      return
    if (
      tokens.some(
        (i) =>
          i.text?.trim() &&
          !f.source.includes(i) &&
          i.rect[0] < f.crop[2] &&
          i.rect[2] > f.crop[0] &&
          i.rect[1] < f.crop[3] &&
          i.rect[3] > f.crop[1]
      )
    )
      return
  }
  const records = [],
    anchors = []
  let sharedTail = false
  for (const row of f.physical) {
    const values = readSourceRow(row, f.cuts)
    if (!values) return
    if (values[0].trim()) {
      if (
        !/^\d+$/.test(values[0]) ||
        values.some((v) => !v.trim()) ||
        (!legacy && values.slice(1).some((v) => !/\p{L}/u.test(v))) ||
        row.filter((i) => i.rect[2] < f.cuts[1]).length !== 1
      )
        return
      anchors.push(Number(values[0]))
      records.push([...row])
    } else {
      if (!records.length || values.slice(1).every((v) => !v.trim())) return
      for (const i of row) {
        const column = f.cuts.slice(1).findIndex((x, n) => i.rect[0] >= f.cuts[n] && i.rect[2] <= x)
        if (
          column < 1 ||
          !records
            .at(-1)
            .some(
              (a) =>
                a.rect[0] >= f.cuts[column] &&
                a.rect[2] <= f.cuts[column + 1] &&
                Math.abs(a.rect[0] - i.rect[0]) < f.em * 0.02
            )
        )
          return
      }
      sharedTail ||= values.slice(1).every((v) => v.trim())
      records.at(-1).push(...row)
    }
  }
  if (
    records.length < 4 ||
    !sharedTail ||
    (!legacy && anchors[0] !== 1) ||
    anchors.some((v, n) => n && v !== anchors[n - 1] + 1) ||
    !hasUniqueRecordTokens(f.source, [f.header, ...records])
  )
    return
  // Closing a numbered bibliography crop would remove the boundary issue used
  // by its existing rejection guards. These are citation records, not measured
  // ordinal/prose comparisons; retain the previous producer output instead.
  if (
    !legacy &&
    records.filter((row) => {
      const prose = row
        .filter((i) => i.rect[0] >= f.cuts[1])
        .map((i) => i.text)
        .join(' ')
      return (
        /\b(?:19|20)\d{2}\b/u.test(prose) &&
        /\b(?:Journal|doi|et al\.)/iu.test(prose) &&
        prose.trim().split(/\s+/u).length >= 8
      )
    }).length >= 3
  )
    return
  return grid(f, records)
}
