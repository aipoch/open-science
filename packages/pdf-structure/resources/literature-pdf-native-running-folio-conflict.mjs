/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as equal, types } from 'node:util'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { nativePageControlInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import {
  nativeRecoveryOwnValues,
  retainNativeRecoveryInputs
} from './literature-pdf-native-figure-recovery-profile.mjs'

const frames = new WeakMap(),
  finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
  valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3],
  sameOrigin = (a, b) =>
    a?.pageNumber === b.pageNumber && a?.index === b.index && a?.text === b.text,
  digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function ownArray(value, limit) {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit
  )
    return false
  return Array.from({ length: value.length }, (_, index) =>
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(index)) ?? {}, 'value')
  ).every(Boolean)
}

function footer(page, context) {
  const values = nativeRecoveryOwnValues(context)
  if (!values) return
  const v = values.viewport,
    content = values.content
  if (
    !nativeRecoveryOwnValues(page) ||
    !nativeRecoveryOwnValues(context) ||
    !Number.isSafeInteger(page.pageNumber) ||
    page.pageNumber < 1 ||
    page.pageNumber > 9999 ||
    page.rotation !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    !Number.isFinite(page.width) ||
    !(page.width > 0) ||
    !Number.isFinite(page.height) ||
    !(page.height > 0) ||
    !v ||
    !['width', 'height', 'scale', 'rotation', 'transform'].every((k) =>
      Object.hasOwn(Object.getOwnPropertyDescriptor(v, k) ?? {}, 'value')
    ) ||
    v.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height ||
    !equal(v.transform, [1, 0, 0, -1, 0, page.height]) ||
    !nativeRecoveryOwnValues(content) ||
    !ownArray(content.items, 4096) ||
    content.items.some(
      (item) =>
        !nativeRecoveryOwnValues(item) ||
        (item.sourceItem && !nativeRecoveryOwnValues(item.sourceItem))
    )
  )
    return
  const items = content.items.filter((r) => typeof r.str === 'string' && r.str.trim()),
    tokens = items.map((r) => tableTextToken(r, v, 0)),
    candidates = tokens.filter(
      (t) =>
        t.text === String(page.pageNumber) &&
        t.horizontal &&
        t.height > 0 &&
        t.rect[1] > page.height * 0.9 &&
        t.rect[2] - t.rect[0] < t.height * 3 &&
        Math.abs((t.rect[0] + t.rect[2]) / 2 - page.width / 2) < page.width * 0.1
    )
  if (candidates.length !== 1) return
  const token = candidates[0],
    origin = token.sourceItem
  if (
    !origin ||
    !sameOrigin(origin, {
      pageNumber: page.pageNumber,
      index: content.items.indexOf(items.at(-1)),
      text: token.text
    }) ||
    content.items[origin.index]?.str !== origin.text
  )
    return
  return { origin, tokens }
}

// This cheap gate requests neighboring native contexts; it grants no role.
export function nativeRunningFolioClaim(table, page, context) {
  try {
    if (
      !nativeRecoveryOwnValues(table) ||
      !ownArray(table.cells, 4096) ||
      table.cells.some(
        (cell) =>
          !nativeRecoveryOwnValues(cell) ||
          (cell.sourceItems === undefined ? cell.text !== '' : !ownArray(cell.sourceItems, 4096)) ||
          (cell.sourceItems !== undefined &&
            cell.sourceItems.some((origin) => !nativeRecoveryOwnValues(origin)))
      )
    )
      return
    const f = footer(page, context)
    if (
      !f ||
      !table.cells.some(
        (c) => Array.isArray(c?.sourceItems) && c.sourceItems.some((o) => sameOrigin(o, f.origin))
      )
    )
      return
    return { ...f.origin }
  } catch {
    return
  }
}

function loadedFont(nativePage, nativeContent, context, origin) {
  const item = nativeContent.items[origin.index],
    name = item.fontName,
    objects = nativePage.commonObjs,
    font = objects?.get?.(name),
    data = font?.data,
    style = nativeContent.styles[name]
  if (
    !font ||
    types.isProxy(font) ||
    !(data instanceof Uint8Array) ||
    Object.getPrototypeOf(data) !== Uint8Array.prototype ||
    !data.length ||
    data.length > 32 * 1024 * 1024 ||
    font.loadedName !== name ||
    font.missingFile !== false ||
    font.isType3Font !== false ||
    // PDF.js enables remeasure by truthiness; an undeclared getter value is
    // unchanged and means disabled in this same native rendering branch.
    font.isInvalidPDFjsFont !== false ||
    font.vertical !== false ||
    font.remeasure ||
    !finite(font.fontMatrix, 6) ||
    !Number.isFinite(font.ascent) ||
    !Number.isFinite(font.descent) ||
    font.ascent !== style.ascent ||
    font.descent !== style.descent ||
    style.vertical !== false ||
    nativePage.pageNumber !== origin.pageNumber ||
    context.content.items[origin.index].str !== item.str
  )
    return
  const bytes = digest(data),
    properties = [
      font.loadedName,
      font.missingFile,
      font.isType3Font,
      font.isInvalidPDFjsFont,
      font.vertical,
      font.remeasure,
      font.ascent,
      font.descent,
      [...font.fontMatrix]
    ],
    buffer = data.buffer,
    offset = data.byteOffset,
    length = data.byteLength
  return {
    objects,
    bytes,
    unchanged: () => {
      // FontInfo.data exposes a fresh view on its native program buffer. Bind
      // that exact allocation/range and bytes, rather than the transient view.
      const current = font.data
      return (
        nativePage.commonObjs === objects &&
        objects.get(name) === font &&
        current instanceof Uint8Array &&
        Object.getPrototypeOf(current) === Uint8Array.prototype &&
        current.buffer === buffer &&
        current.byteOffset === offset &&
        current.byteLength === length &&
        digest(current) === bytes &&
        equal(properties, [
          font.loadedName,
          font.missingFile,
          font.isType3Font,
          font.isInvalidPDFjsFont,
          font.vertical,
          font.remeasure,
          font.ascent,
          font.descent,
          [...font.fontMatrix]
        ])
      )
    }
  }
}

// The frame owns only a page-control claim. All other native ink remains foreign.
export function createNativeRunningFolioFrame(page, context, { nativePage, nativeContent } = {}) {
  try {
    const values = nativeRecoveryOwnValues(context)
    if (!values) return
    const v = values.viewport,
      unchanged = retainNativeRecoveryInputs([page, context, nativeContent], v),
      f = unchanged && footer(page, context)
    if (!f || !unchanged || !/^[a-f\d]{64}$/u.test(context.sourceSha256 ?? '')) return
    const snapshot = {
        ...context,
        pageNumber: page.pageNumber,
        viewport: {
          width: v.width,
          height: v.height,
          scale: v.scale,
          rotation: v.rotation,
          transform: Array.from(v.transform)
        }
      },
      bound = matchNativeFigureRenderContext(
        snapshot,
        page.pageNumber,
        nativeContent,
        v,
        page.graphicsBounds,
        context.sourceSha256
      )
    if (!bound) return
    const font = loadedFont(nativePage, nativeContent, context, f.origin),
      packet = nativePageControlInkPacket(
        page,
        f.tokens,
        { ...context, pageNumber: page.pageNumber },
        f.origin,
        context.dualApiEvidence
      ),
      record = packet?.records.find((r) => r.index === f.origin.index)
    if (
      !font ||
      !record?.advanceComplete ||
      !valid(record.ink) ||
      record.ink[1] <= page.height * 0.9 ||
      packet.records.length !== f.tokens.length
    )
      return
    const owned = new Set(record.part.map((p) => p.g)),
      bandTop = page.height * 0.9,
      separated = (r, pad = 0) =>
        valid(r) && Number.isFinite(pad) && pad >= 0 && r[3] + pad < bandTop
    if (
      !record.part.length ||
      record.part.some(
        ({ g }) =>
          g.rendererSkipped ||
          !valid(g.ink) ||
          g.textPaint?.fillAlpha !== 1 ||
          !/^#[0-9a-f]{6}$/iu.test(g.textPaint.fillColor) ||
          g.textPaint.fillColor.toLowerCase() === '#ffffff'
      ) ||
      packet.glyphs.some(
        (g) =>
          !finite(g.ink, 4) ||
          (!owned.has(g) && !g.rendererSkipped && valid(g.ink) && !separated(g.ink, 1))
      )
    )
      return
    for (const [index, state] of packet.evidence.paths) {
      const a = packet.o.argsArray[index]
      if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null))
        continue
      const paint = nativeFigurePathPaint(packet, index, state)
      if (!paint || !separated(paint.rect, Math.max(1, paint.floor))) return
    }
    if (
      packet.evidence.images.some((image) => !separated(image.rect, 1)) ||
      !unchanged() ||
      !font.unchanged()
    )
      return
    const token = Object.freeze({})
    frames.set(token, {
      page,
      context,
      origin: f.origin,
      font,
      unchanged,
      glyphs: record.part.map(({ g }) => ({
        text: g.text,
        ink: [...g.ink],
        advance: [...g.advance]
      }))
    })
    return token
  } catch {
    return
  }
}

function samePlacement(a, b) {
  return (
    equal(
      a.glyphs.map((g) => g.advance),
      b.glyphs.map((g) => g.advance)
    ) || a.glyphs.some((g) => b.glyphs.some((h) => g.text === h.text && equal(g.ink, h.ink)))
  )
}

export function reviewNativeRunningFolioConflict(table, current, neighbors) {
  try {
    const mid = frames.get(current),
      a = frames.get(neighbors?.[0]),
      b = frames.get(neighbors?.[1])
    if (
      !mid ||
      !a ||
      !b ||
      neighbors.length !== 2 ||
      a.page.pageNumber + 1 !== mid.page.pageNumber ||
      mid.page.pageNumber + 1 !== b.page.pageNumber ||
      ![a, mid, b].every(
        (r) =>
          r.unchanged() &&
          r.font.unchanged() &&
          r.page.width === mid.page.width &&
          r.page.height === mid.page.height &&
          r.context.sourceSha256 === mid.context.sourceSha256 &&
          r.font.objects === mid.font.objects &&
          r.font.bytes === mid.font.bytes
      ) ||
      !samePlacement(a, mid) ||
      !samePlacement(mid, b) ||
      !sameOrigin(nativeRunningFolioClaim(table, mid.page, mid.context), mid.origin) ||
      (table.page !== undefined && table.page !== mid.page.pageNumber) ||
      !Array.isArray(table.issues) ||
      table.issues.includes('native-table-structure-ambiguous')
    )
      return
    return {
      ...table,
      issues: [...table.issues, 'native-table-structure-ambiguous'],
      review: false
    }
  } catch {
    return
  }
}
