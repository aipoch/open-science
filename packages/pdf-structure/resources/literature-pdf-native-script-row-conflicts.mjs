/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual as equal } from 'node:util'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
const compact = (s) => s.replace(/\s/gu, ''),
  key = (o) => `${o.pageNumber}:${o.index}`
const close = (a, b, h) => Math.abs(a - b) < h * 0.025
const sameRect = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === 4 &&
  b.length === 4 &&
  a.every((n, i) => Number.isFinite(n) && Math.abs(n - b[i]) < 1e-6)
const overlap = (a, b) =>
  a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6

// A complete two-sided native script cannot be reliably assigned to adjacent grid rows.
// Report only ambiguity; do not reconstruct mathematics or publish new source claims.
export function nativeSignedScriptRowConflicts(table, inventory, rules, context) {
  try {
    if (
      table.parts ||
      table.cropRects ||
      !Array.isArray(table.cells) ||
      table.cells.length > 4096 ||
      !Array.isArray(inventory) ||
      inventory.length > 4096 ||
      !Array.isArray(rules) ||
      rules.length > 4096 ||
      context?.sourceContent?.items?.length > 4096 ||
      context?.nativeGlyphContext?.operators?.fnArray?.length > 100000
    )
      return []
    let total = 0
    for (const c of table.cells) if ((total += c.sourceItems?.length ?? 0) > 4096) return []
    const owners = new Map(),
      native = new Map(inventory.map((f) => [key(f.sourceItem), f]))
    const all = table.cells.flatMap((c) => c.sourceItems ?? [])
    for (const o of all) owners.set(key(o), (owners.get(key(o)) ?? 0) + 1)
    const cells = table.cells.flatMap((cell) => {
      if (
        cell.sourceSegments?.length ||
        !cell.sourceItems?.length ||
        cell.sourceItems.length !== cell.sourceRects?.length
      )
        return []
      const fonts = cell.sourceItems.map((o) => native.get(key(o)))
      if (
        fonts.some(
          (f, i) =>
            !f ||
            owners.get(key(f.sourceItem)) !== 1 ||
            !equal(f.sourceItem, cell.sourceItems[i]) ||
            !sameRect(f.rect, cell.sourceRects[i])
        ) ||
        compact(cell.text) !== compact(fonts.map((f) => f.text).join(''))
      )
        return []
      return [{ cell, fonts }]
    })
    const fonts = cells.flatMap((p) => p.fonts)
    if (!proveNativeUniqueWholeFonts(fonts, inventory)) return []
    const sequence = uniqueSignedScriptTopology(cells, fonts, native, table.page)
    if (!sequence) return []
    const { base, seq } = sequence,
      p = context?.nativeGlyphContext,
      v = context?.viewport,
      source = context?.sourceContent
    if (
      !p ||
      context.content !== source ||
      p.sourceSha256 !== context.sourceSha256 ||
      !/^[a-f0-9]{64}$/u.test(p.sourceSha256) ||
      p.viewport?.scale !== 1 ||
      p.viewport.rotation !== 0 ||
      v?.rotation !== 0 ||
      !(v.scale > 0) ||
      !equal(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
      v.width !== p.viewport.width * v.scale ||
      v.height !== p.viewport.height * v.scale ||
      !equal(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height])
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
      source.items.some((s, i) => !equal(s.sourceItem, bound.content.items[i].sourceItem))
    )
      return []
    const aliases = new Map(),
      reverse = new Map()
    for (const [s, i] of bound.content.items.map((s, i) => [s, i])) {
      const target = source.items[i].fontName
      if (
        (aliases.has(s.fontName) && aliases.get(s.fontName) !== target) ||
        (reverse.has(target) && reverse.get(target) !== s.fontName)
      )
        return []
      aliases.set(s.fontName, target)
      reverse.set(target, s.fontName)
    }
    const mapped = (a) =>
      Array.isArray(a) ? a.map(mapped) : typeof a === 'string' ? (aliases.get(a) ?? a) : a
    if (
      !equal(bound.operators.fnArray, context.operators?.fnArray) ||
      !equal(mapped(bound.operators.argsArray), context.operators?.argsArray)
    )
      return []
    const tokens = bound.content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, bound.viewport, 0)),
      byIndex = new Map(tokens.map((t) => [t.sourceItem.index, t]))
    const claimed = [...fonts].sort((a, b) => a.sourceItem.index - b.sourceItem.index)
    if (
      claimed.some((f) => {
        const t = byIndex.get(f.sourceItem.index)
        return (
          !t ||
          !sameRect(
            f.rect,
            t.rect.map((n) => n * v.scale)
          ) ||
          Math.abs(f.height - t.height * v.scale) > 1e-6 ||
          Math.abs(f.baseline - t.baseline * v.scale) > 1e-6 ||
          f.horizontal !== true ||
          t.horizontal !== true
        )
      })
    )
      return []
    const packet = nativeWholeCellInkPacket(context.sourcePage, tokens, bound, {
      text: claimed.map((f) => f.text).join(''),
      sourceItems: claimed.map((f) => f.sourceItem),
      sourceRects: claimed.map((f) => byIndex.get(f.sourceItem.index).rect)
    })
    if (!packet) return []
    const witness = [base, ...seq],
      records = witness.map((f) => packet.records.find((r) => r.index === f.sourceItem.index))
    if (
      claimed.some((f) => {
        const r = packet.records.find((r) => r.index === f.sourceItem.index)
        return (
          !r?.advanceComplete ||
          r.part.some(
            ({ g }) =>
              g.rendererSkipped === true ||
              g.textPaint?.fillColor !== '#000000' ||
              g.textPaint?.fillAlpha !== 1
          )
        )
      })
    )
      return []
    const ink = records.flatMap((r) => r.part.map(({ g }) => g.ink)),
      box = [
        Math.min(...ink.map((r) => r[0])),
        Math.min(...ink.map((r) => r[1])),
        Math.max(...ink.map((r) => r[2])),
        Math.max(...ink.map((r) => r[3]))
      ],
      ids = new Set(witness.map((f) => f.sourceItem.index))
    if (
      packet.records.some((r) => !ids.has(r.index) && r.part.some(({ g }) => overlap(g.ink, box)))
    )
      return []
    if (!nativeScriptPaintIsClear(packet, box, v.scale)) return []
    return ['native-signed-script-crosses-table-rows']
  } catch {
    return []
  }
}

function uniqueSignedScriptTopology(cells, fonts, native, page) {
  const owner = new Map(cells.flatMap((p) => p.fonts.map((f) => [f, p])))
  const sequences = []
  for (const base of fonts) {
    const own = owner.get(base),
      h = base.height,
      r = own.cell.row,
      c = own.cell.column
    if (r < 2 || own.cell.rowSpan !== 1 || own.cell.colSpan !== 1 || !/^\p{L}$/u.test(base.text))
      continue
    const sourceIndex = base.sourceItem.index
    const seq = [1, 2, 3].map((n) => native.get(`${page}:${sourceIndex + n}`)),
      [sign, upper, lower] = seq
    if (
      seq.some((f) => !f) ||
      !/^[-−+]$/u.test(sign.text) ||
      !/^\p{L}$/u.test(upper.text) ||
      !/^\p{L}$/u.test(lower.text)
    )
      continue
    const previous = owner.get(sign),
      up = owner.get(upper),
      lo = owner.get(lower)
    if (
      !previous ||
      previous !== up ||
      lo !== own ||
      previous.cell.row !== r - 1 ||
      previous.cell.column !== c ||
      previous.cell.rowSpan !== 1 ||
      previous.cell.colSpan !== 1
    )
      continue
    if (
      !seq.every((f) => f.height / h > 0.6 && f.height / h < 0.76) ||
      !close(sign.height, upper.height, h) ||
      !close(sign.height, lower.height, h) ||
      !close(sign.baseline, upper.baseline, h)
    )
      continue
    if (!(
      base.baseline - sign.baseline > h * 0.3 &&
      base.baseline - sign.baseline < h * 0.55 &&
      lower.baseline - base.baseline > h * 0.15 &&
      lower.baseline - base.baseline < h * 0.35
    ))
      continue
    if (!(
      sign.rect[0] - base.rect[2] >= -h * 0.03 &&
      sign.rect[0] - base.rect[2] < h * 0.15 &&
      Math.abs(lower.rect[0] - sign.rect[0]) < h * 0.08 &&
      Math.abs(upper.rect[0] - sign.rect[2]) < h * 0.03
    ))
      continue
    const calibrated = (row, baseline) =>
      new Set(
        cells
          .filter(
            (p) =>
              p.cell.row === row &&
              p.cell.column !== c &&
              p.cell.rowSpan === 1 &&
              p.cell.colSpan === 1 &&
              p.fonts.some((f) => close(f.height, h, h) && close(f.baseline, baseline, h)) &&
              p.fonts
                .filter((f) => close(f.height, h, h))
                .every((f) => close(f.baseline, baseline, h))
          )
          .map((p) => p.cell.column)
      ).size >= 2
    const before = previous.fonts.filter((f) => f !== sign && f !== upper && close(f.height, h, h))
    const next = cells
      .filter((p) => p.cell.row === r + 1 && p.cell.column !== c)
      .flatMap((p) => p.fonts)
      .filter((f) => close(f.height, h, h))
    if (
      !before.length ||
      !next.length ||
      !before.every(
        (f) => close(f.baseline, before[0].baseline, h) && f.rect[2] < base.rect[0] - h * 0.5
      ) ||
      !calibrated(r, base.baseline) ||
      !calibrated(r - 1, before[0].baseline) ||
      !calibrated(r + 1, next[0].baseline)
    )
      continue
    if (!(
      base.baseline - before[0].baseline > h &&
      base.baseline - before[0].baseline < h * 1.6 &&
      next[0].baseline - base.baseline > h &&
      next[0].baseline - base.baseline < h * 1.6
    ))
      continue
    sequences.push({ base, seq, own, previous })
  }
  if (sequences.length !== 1) return
  return sequences[0]
}

export function nativeScriptPaintIsClear(packet, box, scale) {
  // Reuse the existing packet path/clip/stroke contract. A fixed rule padding is not paint proof.

  for (const [id, state] of packet.evidence.paths) {
    const a = packet.o.argsArray[id]
    // PDF.js constructPath(null minMax, null path) constructs a new empty Path2D.
    if (a?.length === 3 && a[1]?.length === 1 && a[1][0] === null && a[2] === null) continue
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    if (!packet.finite(a?.[2], 4) || !packet.finite(state.transform, 6)) {
      return false
    }
    const pad = [
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ].includes(a[0])
      ? (state.lineWidth * Math.max(1, packet.strokeMargins.get(id) ?? 10)) / 2
      : 0
    if (
      !Number.isFinite(pad) ||
      pad < 0 ||
      (pad === 0 &&
        [
          OPS.stroke,
          OPS.closeStroke,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke
        ].includes(a[0]))
    ) {
      return false
    }
    const matrix = Util.transform(packet.v.transform, state.transform),
      det = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])
    if (!packet.finite(matrix, 6) || !Number.isFinite(det) || !(det > 0)) return false
    // PDF.js enforces a device-pixel minimum. The Frobenius condition bound also
    // covers nonuniform/sheared CTMs; overestimating paint only rejects proof.
    const pixelPad =
      pad > 0
        ? (Math.max(1, 1 / scale) *
            Math.max(1, packet.strokeMargins.get(id) ?? 10) *
            (matrix[0] ** 2 + matrix[1] ** 2 + matrix[2] ** 2 + matrix[3] ** 2)) /
          det /
          2
        : 0
    if (!Number.isFinite(pixelPad) || pixelPad < 0) return false
    let q = packet
      .box(
        Array.from(a[2], (n, k) => n + (k < 2 ? -pad : pad)),
        matrix
      )
      .map((n, k) => n + (k < 2 ? -pixelPad : pixelPad))
    if (!packet.finite(q, 4)) return false
    if (state.clip) {
      if (!packet.finite(state.clip, 4)) return false
      if (!packet.valid(state.clip)) continue
      q = [
        Math.max(q[0], state.clip[0]),
        Math.max(q[1], state.clip[1]),
        Math.min(q[2], state.clip[2]),
        Math.min(q[3], state.clip[3])
      ]
    }
    if (!packet.finite(q, 4)) return false
    if (!packet.valid(q)) continue
    if (overlap(q, box)) {
      return false
    }
  }
  if (packet.evidence.images.some((im) => !packet.valid(im.rect) || overlap(im.rect, box)))
    return false

  return true
}
