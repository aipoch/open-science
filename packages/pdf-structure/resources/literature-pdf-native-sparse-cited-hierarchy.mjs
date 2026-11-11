/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFramedRecordClosure } from './literature-pdf-native-cited-prose-records.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const same = (a, b) => a?.length === b?.length && a.every((x, n) => Math.abs(x - b[n]) < 0.02)
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((x, n) => (n < 2 ? x >= a[n] - 0.02 : x <= a[n] + 0.02))
const compact = (s) => s.normalize('NFD').replace(/\s/gu, '')
const citation = /^\[\d+(?:\s*(?:,|[–—-])\s*\d+)*\]$/u

// Complete native fences own each nonnumeric category. Within a fence pair,
// Source-program field cycles and aligned terminal citations independently
// identify leaf records. No blank quantity or detector row supplies scope.
export function recoverNativeSparseCitedHierarchyGrid(table, inventory, captions, rules, context) {
  try {
    const crop = table?.cropRect,
      page = context?.sourcePage,
      native = context?.nativeGlyphContext,
      v = context?.viewport,
      scale = v?.scale,
      carrier = context?.sourceContent
    if (
      !valid(crop) ||
      table.readingRotation ||
      !page ||
      !native ||
      !Array.isArray(inventory) ||
      !Array.isArray(rules) ||
      !Array.isArray(captions) ||
      context.content !== carrier ||
      scale !== 1.5 ||
      v.rotation ||
      native.viewport?.scale !== 1 ||
      native.viewport.rotation ||
      native.pageNumber !== page.pageNumber ||
      page.rotation ||
      Math.abs(v.width - page.width * scale) > 0.02 ||
      Math.abs(v.height - page.height * scale) > 0.02
    )
      return
    const near = inventory.filter((i) => i.text?.trim() && valid(i.rect) && hit(i.rect, crop)),
      hs = near.map((i) => i.height).sort((a, b) => a - b),
      h = hs[hs.length >> 1]
    if (!(h > 0)) return
    const paint = new Map(),
      nativeRules = collectTableRules(context.operators, v, paint),
      full = nativeRules
        .filter(
          (r) =>
            r[1] === r[3] &&
            r[1] >= crop[1] - h &&
            r[1] <= crop[3] + h &&
            Math.abs(r[0] - crop[0]) < h &&
            Math.abs(r[2] - crop[2]) < h
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
      frame = [opening[0], opening[1], opening[2], closing[1]],
      belongs = (i) =>
        i.text?.trim() &&
        valid(i.rect) &&
        i.rect[0] >= frame[0] - 0.02 &&
        i.rect[2] <= frame[2] + 0.02 &&
        i.baseline > frame[1] &&
        i.baseline < frame[3]
    if (divider[1] - opening[1] < h * 0.5 || divider[1] - opening[1] > h * 2) return
    const source = inventory
      .filter(belongs)
      .sort((a, b) => a.sourceItem?.index - b.sourceItem?.index)
    if (
      !source.length ||
      source.length > 2048 ||
      source.some(
        (i) =>
          !i.horizontal ||
          Math.abs(i.height - h) > 0.02 ||
          i.sourceItem?.pageNumber !== page.pageNumber ||
          i.sourceItem.text !== i.text
      ) ||
      !proveNativeUniqueWholeFonts(source, inventory)
    )
      return
    const originals = carrier.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, v, 0))
      .filter(belongs)
    if (
      originals.length !== source.length ||
      originals.some(
        (i) =>
          source.filter(
            (t) =>
              t.sourceItem.index === i.sourceItem.index && t.text === i.text && same(t.rect, i.rect)
          ).length !== 1
      )
    )
      return
    const domains = []
    for (const i of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = domains.at(-1)
      if (last && i.rect[0] <= last[1] + 0.02) last[1] = Math.max(last[1], i.rect[2])
      else domains.push([i.rect[0], i.rect[2]])
    }
    if (domains.length !== 4) return
    const lane = (i) =>
        domains.findIndex((d) => i.rect[0] >= d[0] - 0.02 && i.rect[2] <= d[1] + 0.02),
      header = source.filter((i) => i.baseline < divider[1]),
      body = source.filter((i) => i.baseline > divider[1])
    if (
      header.length !== 4 ||
      header.some(
        (i, n) =>
          lane(i) !== n ||
          !/\p{L}/u.test(i.text) ||
          Math.abs(i.baseline - header[0].baseline) > 0.02
      ) ||
      header.length + body.length !== source.length
    )
      return
    const records = [],
      groups = [],
      spans = [],
      owned = new Set(header),
      rowBounds = [Math.min(...header.map((i) => i.rect[1])), divider[1]]
    for (let b = 1; b < full.length - 1; b++) {
      const top = full[b][1],
        bottom = full[b + 1][1],
        fonts = body.filter((i) => i.baseline > top && i.baseline < bottom),
        stubs = fonts.filter((i) => lane(i) === 0),
        leaves = []
      if (
        !stubs.length ||
        stubs.length > 6 ||
        !stubs.some((i) => /\p{L}/u.test(i.text)) ||
        stubs.some((i) => /\p{N}/u.test(i.text) || !/^[\p{L}\p{M}\s&/()–—-]+$/u.test(i.text))
      )
        return
      for (const i of fonts.filter((i) => lane(i) > 0)) {
        const previous = leaves.at(-1)?.at(-1)
        if (!previous || (lane(previous) === 3 && lane(i) === 1)) leaves.push([])
        else if (lane(i) < lane(previous)) return
        leaves.at(-1).push(i)
      }
      if (leaves.length < 2 || leaves.length > 12) return
      const bounds = []
      for (const leaf of leaves) {
        const fields = [1, 2, 3].map((c) => leaf.filter((i) => lane(i) === c))
        if (
          fields.some((f) => !f.length || Math.abs(f[0].baseline - leaf[0].baseline) > 0.02) ||
          fields[2].length !== 1 ||
          !citation.test(fields[2][0].text) ||
          fields.slice(0, 2).some((f) => !f.some((i) => /\p{L}/u.test(i.text)))
        )
          return
        for (const field of fields)
          for (let n = 1; n < field.length; n++) {
            const a = field[n - 1],
              z = field[n],
              gap = z.baseline - a.baseline
            if (
              Math.abs(gap) < 0.02 ? z.rect[0] < a.rect[2] - 0.02 : gap < h * 0.85 || gap > h * 1.4
            )
              return
          }
        bounds.push([
          Math.min(...leaf.map((i) => i.rect[1])),
          Math.max(...leaf.map((i) => i.rect[3]))
        ])
      }
      if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
      spans.push({ row: records.length + 1, column: 0, rowSpan: leaves.length, colSpan: 1 })
      groups.push({ top, bottom, stubs, leaves })
      for (let n = 0; n < leaves.length; n++) {
        records.push(leaves[n])
        rowBounds.push(n === leaves.length - 1 ? bottom : (bounds[n][1] + bounds[n + 1][0]) / 2)
      }
      for (const i of fonts) {
        if (owned.has(i)) return
        owned.add(i)
      }
    }
    if (
      owned.size !== source.length ||
      records.length < 4 ||
      (records.length + 1) * 4 > 2048 ||
      rowBounds.some((y, n) => n && y <= rowBounds[n - 1])
    )
      return
    const bound = matchNativeFigureRenderContext(
      native,
      page.pageNumber,
      carrier,
      native.viewport,
      page.graphicsBounds,
      native.sourceSha256
    )
    if (!bound) return
    const c = { ...bound, pageNumber: page.pageNumber, sourceSha256: native.sourceSha256 },
      tokens = c.content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, c.viewport, 0)),
      ids = new Set(source.map((i) => i.sourceItem.index))
    // Existing scoped Source contract: only unclaimed one-to-one foreign
    // normalization may differ. Every claimed literal and advance stays exact.
    const proof = nativePageTextPacketInventory(page, tokens, c, false, ids, true)
    if (!proof) return
    const selected = proof.records.filter((r) => ids.has(r.index)),
      byIndex = new Map(selected.map((r) => [r.index, r]))
    if (
      selected.length !== source.length ||
      source.some((i) => {
        const r = byIndex.get(i.sourceItem.index)
        return (
          !r ||
          !r.advanceComplete ||
          r.foreignSourceNormalized ||
          r.r.str !== i.text ||
          !same(tableTextToken(r.r, v, 0).rect, i.rect) ||
          r.part.some(
            ({ g }) =>
              !valid(g.ink) ||
              g.rendererSkipped ||
              g.textPaint?.fillAlpha !== 1 ||
              g.textPaint.fillColor?.toLowerCase() === '#ffffff'
          )
        )
      })
    )
      return
    const packet = { proof, selected, context: c, page, scale }
    if (
      proof.evidence.paths.size !== full.length ||
      proof.evidence.images.length ||
      !nativeFramedRecordClosure(packet, full)
    )
      return
    const local = nativeRules.filter(
      (r) => r[0] <= frame[2] && r[2] >= frame[0] && r[1] <= frame[3] && r[3] >= frame[1]
    )
    if (
      local.length !== full.length ||
      full.some((r) => rules.filter((s) => same(r, s)).length !== 1 || !paint.has(r.join(','))) ||
      rules.some(
        (r) =>
          r[0] <= frame[2] &&
          r[2] >= frame[0] &&
          r[1] <= frame[3] &&
          r[3] >= frame[1] &&
          !full.some((f) => same(r, f))
      )
    )
      return
    const fontInk = (i) => byIndex.get(i.sourceItem.index).ink.map((x) => x * scale)
    if (
      header.some((i) => !inside([frame[0], opening[1], frame[2], divider[1]], fontInk(i))) ||
      groups.some((g) =>
        [...g.stubs, ...g.leaves.flat()].some(
          (i) => !inside([frame[0], g.top, frame[2], g.bottom], fontInk(i))
        )
      )
    )
      return
    const cuts = [
        frame[0],
        ...domains.slice(1).map((d, n) => (domains[n][1] + d[0]) / 2),
        frame[2]
      ],
      painted = full.map((r) => paint.get(r.join(','))),
      cropRect = [
        Math.min(crop[0], ...painted.map((r) => r[0])),
        Math.min(...source.map((i) => i.rect[1]), ...painted.map((r) => r[1])),
        Math.max(crop[2], ...painted.map((r) => r[2])),
        Math.max(crop[3], ...painted.map((r) => r[3]))
      ]
    if (!valid(cropRect)) return
    const claimed = new Set(selected.flatMap((r) => r.part.map((z) => z.g)))
    if (
      proof.glyphs.some(
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
    const titles = captions.filter(
      (cap) =>
        cap.page === page.pageNumber &&
        captionKind(cap.lines?.[0]) === 'table' &&
        valid(cap.rect) &&
        cap.rect[0] < frame[2] &&
        cap.rect[2] > frame[0] &&
        cap.rect[3] < opening[1] &&
        opening[1] - cap.rect[3] < h * 4
    )
    if (titles.length !== 1) return
    const title = proof.records.filter(
      (r) =>
        valid(r.rect) &&
        hit(
          r.rect.map((x) => x * scale),
          titles[0].rect
        )
    )
    if (
      !title.length ||
      title.some(
        (r) =>
          !r.advanceComplete ||
          !inside(
            titles[0].rect,
            r.rect.map((x) => x * scale)
          )
      ) ||
      compact(title.map((r) => r.r.str).join('')) !== compact(titles[0].lines.join(''))
    )
      return
    cuts[0] = cropRect[0]
    cuts[4] = cropRect[2]
    rowBounds[0] = cropRect[1]
    rowBounds[rowBounds.length - 1] = cropRect[3]
    return {
      cropRect,
      columns: cuts.slice(1).map((x, n) => [cuts[n], cropRect[1], x, cropRect[3]]),
      rows: rowBounds.slice(1).map((y, n) => [cuts[0], rowBounds[n], cuts[4], y]),
      spans,
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
