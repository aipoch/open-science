/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeWhitespaceGaps } from './literature-pdf-symbol-text.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const same = (a, b) => a?.length === b?.length && a.every((v, n) => Math.abs(v - b[n]) < 0.02)
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 0.02 : v <= a[n] + 0.02))
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const compact = (s) => s.normalize('NFD').replace(/\s/gu, '')
const originKey = (o) => JSON.stringify([o?.pageNumber, o?.index, o?.text])
const cellLiteralMatches = (cell) => {
  const parts = cell.sourceTokens
  if (compact(parts.map((token) => token.text).join('')) === compact(cell.text)) return true
  // Preserve the existing prose serializer's optional printed line-hyphen
  // projection. Ownership still covers every original hyphen glyph below.
  const joined = parts
    .map((token, index) => {
      const next = parts[index + 1]
      return next &&
        /\p{L}-$/u.test(token.text) &&
        /^\p{Ll}/u.test(next.text) &&
        Math.abs(token.height - next.height) < 0.02 &&
        next.baseline - token.baseline > token.height * 0.7 &&
        next.baseline - token.baseline < token.height * 1.5
        ? token.text.slice(0, -1)
        : token.text
    })
    .join('')
  return compact(joined) === compact(cell.text)
}

// Existing Source-purpose whole-cell evidence accepts a complete font spanning
// several native TJ operations. It does not relax the ordinary single-TJ gate.
// Only an empty leaf heading beside one whole fused font can opt in here.
export function repairNativeMeasuredHeadingOwners(table, inventory, captions, rules, context) {
  try {
    const page = context?.sourcePage,
      native = context?.nativeGlyphContext,
      source = context?.sourceContent,
      v = context?.viewport,
      count = table?.grid?.[0]?.length,
      rows = table?.grid?.length,
      scale = v?.scale
    if (
      !page ||
      !native ||
      !source?.items ||
      context.content !== source ||
      scale !== 1.5 ||
      v.rotation ||
      native.viewport?.scale !== 1 ||
      native.viewport.rotation ||
      native.pageNumber !== page.pageNumber ||
      !valid(table.cropRect) ||
      !Array.isArray(inventory) ||
      !Array.isArray(captions) ||
      !Array.isArray(rules) ||
      !Number.isInteger(count) ||
      count < 4 ||
      count > 8 ||
      rows < 4 ||
      rows > 256 ||
      rows * count > 2048 ||
      table.grid.some((r) => r.length !== count || r.some((t) => typeof t !== 'string')) ||
      !Array.isArray(table.cells) ||
      table.cells.length !== rows * count ||
      table.unassigned?.length ||
      table.parts?.length ||
      table.readingRotation ||
      v.width !== page.width * scale ||
      v.height !== page.height * scale
    )
      return
    const slots = new Set()
    for (const cell of table.cells) {
      const key = cell.row + ',' + cell.column
      if (
        !Number.isInteger(cell.row) ||
        !Number.isInteger(cell.column) ||
        cell.row < 0 ||
        cell.row >= rows ||
        cell.column < 0 ||
        cell.column >= count ||
        cell.rowSpan !== 1 ||
        cell.colSpan !== 1 ||
        !valid(cell.rect) ||
        typeof cell.text !== 'string' ||
        cell.text !== table.grid[cell.row][cell.column] ||
        slots.has(key) ||
        cell.sourceSegments?.length ||
        !Array.isArray(cell.sourceTokens) ||
        !Array.isArray(cell.sourceRects)
      )
        return
      slots.add(key)
    }
    const heads = table.cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column),
      blank = heads[0],
      donor = heads[1]
    if (
      blank.text ||
      blank.sourceTokens.length ||
      blank.sourceRects.length ||
      blank.sourceItems?.length ||
      donor.sourceItems?.length !== 1 ||
      donor.sourceTokens.length !== 1 ||
      donor.sourceRects.length !== 1 ||
      donor.text !== donor.sourceItems[0].text ||
      heads.slice(2).some((c) => !c.text.trim())
    )
      return
    const selected = inventory.filter(
        (t) => t.text?.trim() && valid(t.rect) && hit(t.rect, table.cropRect)
      ),
      heights = selected.map((t) => t.height).sort((a, b) => a - b),
      em = heights[heights.length >> 1]
    if (
      !(em > 0) ||
      selected.some(
        (t) =>
          !t.horizontal ||
          t.sourceToken ||
          t.sourceSegment ||
          !t.sourceItem ||
          t.sourceItem.pageNumber !== page.pageNumber ||
          t.sourceItem.text !== t.text
      )
    )
      return
    const full = rules
      .filter(
        (r) =>
          r?.length === 4 &&
          r.every(Number.isFinite) &&
          r[1] === r[3] &&
          r[1] >= table.cropRect[1] - em &&
          r[1] <= table.cropRect[3] + em &&
          Math.abs(r[0] - table.cropRect[0]) < em &&
          Math.abs(r[2] - table.cropRect[2]) < em
      )
      .sort((a, b) => a[1] - b[1])
    if (
      full.length !== 3 ||
      full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
    )
      return
    const [opening, divider, closing] = full,
      frame = [opening[0], opening[1], opening[2], closing[1]]
    if (
      selected.some((t) => !inside(frame, t.rect)) ||
      !inside([frame[0], opening[1], frame[2], divider[1]], donor.sourceRects[0])
    )
      return
    const bound = matchNativeFigureRenderContext(
      native,
      page.pageNumber,
      source,
      native.viewport,
      page.graphicsBounds,
      native.sourceSha256
    )
    if (!bound) return
    const c = { ...bound, pageNumber: page.pageNumber, sourceSha256: native.sourceSha256 },
      tokens = c.content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, c.viewport, 0)),
      originals = selected.slice().sort((a, b) => a.sourceItem.index - b.sourceItem.index),
      packet = nativeWholeCellInkPacket(page, tokens, c, {
        text: originals.map((t) => t.text).join(''),
        sourceItems: originals.map((t) => t.sourceItem),
        sourceRects: originals.map((t) => t.rect.map((x) => x / scale))
      })
    if (!packet) return
    const records = new Map(),
      originalByIndex = new Map()
    for (const t of originals) {
      const matches = packet.records.filter((r) => r.index === t.sourceItem.index)
      if (matches.length !== 1 || records.has(matches[0].index)) return
      const r = matches[0],
        nativeToken = tableTextToken(r.r, v, 0)
      if (
        !r.advanceComplete ||
        r.r.str !== t.text ||
        !same(nativeToken.rect, t.rect) ||
        originKey(r.r.sourceItem) !== originKey(t.sourceItem) ||
        r.part.some(
          (z) =>
            !valid(z.g.advance) ||
            !valid(z.g.ink) ||
            z.g.rendererSkipped ||
            z.g.textPaint?.fillAlpha !== 1 ||
            z.g.textPaint.fillColor?.toLowerCase() === '#ffffff' ||
            !inside(
              frame,
              z.g.ink.map((x) => x * scale)
            )
        )
      )
        return
      records.set(r.index, r)
      originalByIndex.set(r.index, t)
    }
    // All unclaimed glyphs remain foreign, including empty-outline source
    // spaces that paint nonempty ink. No native group is skipped or sliced.
    const nativeOwned = new Set([...records.values()].flatMap((r) => r.part.map((z) => z.g)))
    if (
      packet.glyphs.some(
        (g) =>
          !nativeOwned.has(g) &&
          valid(g.ink) &&
          hit(
            g.ink.map((x) => x * scale),
            frame
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
        ((cap.rect[3] < frame[1] && frame[1] - cap.rect[3] < em * 4) ||
          (cap.rect[1] > frame[3] && cap.rect[1] - frame[3] < em * 4))
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
          !inside(
            title[0].rect,
            r.rect.map((x) => x * scale)
          )
      ) ||
      compact(titleFonts.map((r) => r.r.str).join('')) !== compact(title[0].lines.join(''))
    )
      return

    const spanParts = (r, start, end) => {
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end > r.r.str.length ||
        end <= start
      )
        return
      let offset = 0,
        partIndex = 0
      const entries = []
      for (const char of r.r.str) {
        const at = offset
        offset += char.length
        for (const letter of char.normalize('NFD'))
          if (!/\s/u.test(letter)) {
            const z = r.part[partIndex++]
            if (z?.c !== letter) return
            entries.push({ z, start: at, end: offset })
          }
      }
      if (
        partIndex !== r.part.length ||
        entries.some((e) => (e.start < start && e.end > start) || (e.start < end && e.end > end))
      )
        return
      const chosen = entries.filter((e) => e.start >= start && e.end <= end),
        glyphs = new Set(chosen.map((e) => e.z.g))
      if (!glyphs.size || entries.some((e) => glyphs.has(e.z.g) && !chosen.includes(e))) return
      return [...glyphs]
    }
    const owned = new Map(),
      claimed = new Map(),
      slotGlyphs = new Map()
    for (const cell of table.cells) {
      if (!cell.text.trim()) {
        if (cell !== blank) return
        continue
      }
      if (
        !Array.isArray(cell.sourceItems) ||
        !cell.sourceItems.length ||
        !cell.sourceTokens.length ||
        !cellLiteralMatches(cell)
      )
        return
      const origins = cell.sourceItems.map((o) => {
        const r = records.get(o.index)
        return r && originKey(o) === originKey(r.r.sourceItem) ? r : undefined
      })
      if (origins.some((r) => !r) || new Set(origins).size !== origins.length) return
      const all = new Set(),
        pieces = []
      for (const token of cell.sourceTokens) {
        if (typeof token.text !== 'string' || !token.text.trim() || !valid(token.rect)) return
        const matches = []
        for (const r of origins) {
          let pos = -1
          while ((pos = r.r.str.indexOf(token.text, pos + 1)) >= 0) {
            const glyphs = spanParts(r, pos, pos + token.text.length)
            if (
              glyphs &&
              same(
                union(glyphs.map((g) => g.advance)).map((x) => x * scale),
                token.rect
              )
            )
              matches.push({ r, glyphs })
          }
        }
        if (matches.length !== 1) return
        const match = matches[0]
        for (const g of match.glyphs) {
          if (all.has(g) || claimed.has(g)) return
          all.add(g)
          claimed.set(g, cell)
        }
        pieces.push({ record: match.r, rect: token.rect, glyphs: match.glyphs })
      }
      if (
        origins.some((r) => !pieces.some((p) => p.record === r)) ||
        cell.sourceRects.some(
          (rect) =>
            !valid(rect) ||
            (!pieces.some((p) => same(p.rect, rect)) &&
              !origins.some(
                (r) =>
                  r.part.every((z) => all.has(z.g)) && same(originalByIndex.get(r.index).rect, rect)
              ))
        ) ||
        [...all].some(
          (g) =>
            !cell.sourceRects.some((rect) =>
              inside(
                rect,
                g.advance.map((x) => x * scale)
              )
            )
        )
      )
        return
      owned.set(cell, pieces)
      slotGlyphs.set(cell, [...all])
    }
    if (claimed.size !== nativeOwned.size || [...nativeOwned].some((g) => !claimed.has(g))) return
    const body = table.cells.filter((cell) => cell.row > 0),
      domains = []
    if (
      body.some((cell) => !cell.text.trim()) ||
      body
        .filter((cell) => cell.column === 0)
        .some((cell) => !/^[+−-]?\d+(?:\.\d+)?$/u.test(cell.text))
    )
      return
    for (let col = 0; col < count; col++) {
      const glyphs = body
        .filter((cell) => cell.column === col)
        .flatMap((cell) => slotGlyphs.get(cell) ?? [])
      if (!glyphs.length) return
      domains.push([
        Math.min(...glyphs.map((g) => Math.min(g.advance[0], g.ink[0]))) * scale,
        Math.max(...glyphs.map((g) => Math.max(g.advance[2], g.ink[2]))) * scale
      ])
    }
    if (domains.some((d, n) => n && d[0] <= domains[n - 1][1])) return
    const firstGutter = [domains[0][1], domains[1][0]],
      donorOrigin = donor.sourceItems[0],
      record = records.get(donorOrigin.index),
      font = originalByIndex.get(donorOrigin.index),
      observations = nativeWhitespaceGaps(source, context.operators, v).filter(
        (r) =>
          r.text === font.text &&
          same(r.rect, font.rect) &&
          Math.abs(r.baseline - font.baseline) < 0.02
      )
    if (
      observations.length !== 1 ||
      observations[0].glyphRuns?.length !== record.part.length ||
      new Set(observations[0].glyphRuns).size !== 1
    )
      return
    const choices = []
    for (const gap of observations[0].gaps ?? []) {
      if (
        !Number.isInteger(gap.index) ||
        gap.index < 1 ||
        gap.index >= record.part.length ||
        !Number.isFinite(gap.left) ||
        !Number.isFinite(gap.right) ||
        gap.right <= gap.left ||
        gap.left < firstGutter[0] ||
        gap.right > firstGutter[1] ||
        gap.right - gap.left < font.height * 0.25
      )
        continue
      let seen = 0,
        offset = 0,
        at = -1
      for (const char of font.text) {
        if (!/\s/u.test(char)) {
          if (seen === gap.index) {
            at = offset
            break
          }
          seen += [...char.normalize('NFD')].length
        }
        offset += char.length
      }
      if (at < 0 || !/[\s]$/u.test(font.text.slice(0, at))) continue
      const left = font.text.slice(0, at).trimEnd(),
        right = font.text.slice(at).trimStart(),
        end = left.length,
        start = font.text.length - right.length,
        a = spanParts(record, 0, end),
        b = spanParts(record, start, font.text.length)
      if (
        !/^\p{L}[\p{L}\p{N} .-]*$/u.test(left) ||
        !/^\p{L}[\p{L}\p{N} .-]*$/u.test(right) ||
        !a ||
        !b
      )
        continue
      const ra = union(a.map((g) => g.advance)).map((x) => x * scale),
        rb = union(b.map((g) => g.advance)).map((x) => x * scale)
      if (
        Math.abs(ra[2] - gap.left) > 0.02 ||
        Math.abs(rb[0] - gap.right) > 0.02 ||
        a.length + b.length !== new Set(record.part.map((z) => z.g)).size
      )
        continue
      if (
        packet.glyphs.some(
          (g) =>
            valid(g.ink) &&
            hit(
              g.ink.map((x) => x * scale),
              [gap.left, font.rect[1], gap.right, font.rect[3]]
            ) &&
            // Arithmetic equality at this font's measured gap edge must
            // not falsely disambiguate two valid cuts. Exterior glyphs
            // never receive this original-font boundary tolerance.
            !(
              (a.includes(g) &&
                g.advance[2] * scale <= gap.left + 0.02 &&
                g.ink[2] * scale <= gap.left + 0.02) ||
              (b.includes(g) &&
                g.advance[0] * scale >= gap.right - 0.02 &&
                g.ink[0] * scale >= gap.right - 0.02)
            )
        )
      )
        continue
      choices.push({ left, right, end, start, ra, rb, cut: (gap.left + gap.right) / 2 })
    }
    if (choices.length !== 1) return

    // Every local paint must be exactly one original opaque horizontal fence.
    // The whole Source packet retains every exterior path and glyph as well.
    const colors = new Map(),
      stack = []
    let stroke = '#000000'
    for (let i = 0; i < c.operators.fnArray.length; i++) {
      const op = c.operators.fnArray[i],
        a = c.operators.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(stroke)
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!stack.length) return
        stroke = stack.pop()
      } else if (op === OPS.setStrokeRGBColor) stroke = a[0]
      else if (op === OPS.constructPath) colors.set(i, stroke)
    }
    if (stack.length) return
    const paint = new Map(),
      nativeRules = collectTableRules(c.operators, v, paint),
      localRules = nativeRules.filter(
        (r) => r[0] <= frame[2] && r[2] >= frame[0] && r[1] <= frame[3] && r[3] >= frame[1]
      )
    if (
      localRules.length !== 3 ||
      full.some(
        (r) => localRules.filter((n) => same(n, r) && paint.has(n.join(','))).length !== 1
      ) ||
      rules.some(
        (r) =>
          r[0] <= frame[2] &&
          r[2] >= frame[0] &&
          r[1] <= frame[3] &&
          r[3] >= frame[1] &&
          !full.some((f) => same(f, r))
      )
    )
      return
    const seenFences = new Set()
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
      if (!hit(bounds, frame)) continue
      const p = a[1]?.[0]
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
        edge = full.findIndex((f) => same(f, line))
      if (
        edge < 0 ||
        seenFences.has(edge) ||
        !valid(path.clip) ||
        !inside(
          path.clip,
          bounds.map((x) => x / scale)
        )
      )
        return
      seenFences.add(edge)
    }
    if (
      seenFences.size !== 3 ||
      packet.evidence.images.some(
        (i) =>
          !valid(i.rect) ||
          hit(
            i.rect.map((x) => x * scale),
            frame
          )
      )
    )
      return
    const choice = choices[0],
      segments = [
        { ...donorOrigin, start: 0, end: choice.end, rect: choice.ra },
        { ...donorOrigin, start: choice.start, end: font.text.length, rect: choice.rb }
      ],
      replacement = [blank, donor].map((old, index) => {
        const segment = segments[index],
          rect = [
            index ? choice.cut : blank.rect[0],
            old.rect[1],
            index ? donor.rect[2] : choice.cut,
            old.rect[3]
          ],
          token = {
            ...font,
            text: index ? choice.right : choice.left,
            rect: segment.rect,
            sourceItem: undefined,
            sourceSegment: segment,
            sourceToken: font
          },
          cell = {
            ...old,
            rect,
            text: token.text,
            sourceTokens: [token],
            sourceRects: [segment.rect],
            sourceSegments: [segment]
          }
        delete cell.sourceItems
        delete cell.textRuns
        return cell
      })
    if (replacement.some((cell) => !valid(cell.rect) || !inside(cell.rect, cell.sourceRects[0])))
      return
    const cells = table.cells.map((cell) =>
        cell === blank ? replacement[0] : cell === donor ? replacement[1] : cell
      ),
      grid = table.grid.map((row) => [...row])
    grid[0][0] = choice.left
    grid[0][1] = choice.right
    return {
      ...table,
      cells,
      grid,
      repairs: [...new Set([...(table.repairs ?? []), 'native-measured-heading-owners-recovered'])]
    }
  } catch {
    return
  }
}
