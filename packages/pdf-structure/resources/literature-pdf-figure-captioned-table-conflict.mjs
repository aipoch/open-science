/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const same = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((n, i) => Math.abs(n - b[i]) <= 1e-6)
const inside = (a, b) =>
  valid(a) && valid(b) && b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6))
const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const compact = (s) => s.replace(/\s/gu, '')
const absentOrEmpty = (a) => a === undefined || (Array.isArray(a) && a.length === 0)

// This is a final-owner veto, not a native paint admission. It neither proves a
// table's cell mapping nor allocates glyphs, changes sources, or repairs a crop.
// The existing whole native packet and graphics-state guards remain unchanged.
export function refuseFigureBorrowingCaptionedTable(page, figure, tables, tokens, context) {
  try {
    const v = context?.viewport,
      content = context?.content
    if (
      !page ||
      page.rotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      figure?.page !== page.pageNumber ||
      !valid(figure.region) ||
      !figure.thumbnail ||
      figure.sourceItems?.length ||
      figure.parts?.length ||
      captionKind(figure.caption?.lines?.[0] ?? '') !== 'figure' ||
      !valid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      !Array.isArray(tables) ||
      !Array.isArray(tokens) ||
      !Array.isArray(content?.items) ||
      !/^[a-f\d]{64}$/u.test(context.sourceSha256 ?? '') ||
      context.pageNumber !== page.pageNumber ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      !same(v.transform, [1, 0, 0, -1, 0, page.height])
    )
      return figure
    const body = figure.region.map((n, i) => n * (i % 2 ? page.height : page.width))
    if (!inside([0, 0, page.width, page.height], body)) return figure
    const sourceTokens = new Map(),
      fontBounds = new Map()
    for (const token of tokens) {
      const source = token.sourceItem
      if (!source) continue
      const key = `${source.pageNumber}:${source.index}`
      if (!sourceTokens.has(key)) sourceTokens.set(key, [])
      sourceTokens.get(key).push(token)
    }
    for (const font of context.glyphBounds ?? []) {
      if (!fontBounds.has(font.fontName)) fontBounds.set(font.fontName, [])
      fontBounds.get(font.fontName).push(font)
    }
    const bound = (source) => {
      if (
        source?.pageNumber !== page.pageNumber ||
        !Number.isSafeInteger(source.index) ||
        source.index < 0 ||
        typeof source.text !== 'string' ||
        !source.text.trim()
      )
        return
      const raw = content.items[source.index],
        style = content.styles?.[raw?.fontName],
        matches = sourceTokens.get(`${source.pageNumber}:${source.index}`) ?? [],
        fonts = fontBounds.get(raw?.fontName)
      if (
        !raw ||
        raw.str !== source.text ||
        raw.sourceItem?.text !== source.text ||
        raw.sourceItem.index !== source.index ||
        raw.sourceItem.pageNumber !== source.pageNumber ||
        matches.length !== 1 ||
        matches[0].text !== source.text ||
        matches[0].sourceItem.text !== source.text ||
        !Number.isFinite(style?.ascent) ||
        style.ascent <= 0 ||
        !Number.isFinite(style?.descent) ||
        style.descent > 0 ||
        style.vertical ||
        fonts?.length !== 1 ||
        !Array.isArray(fonts[0].glyphs) ||
        !fonts[0].glyphs.length ||
        fonts[0].glyphs.some(
          (g) =>
            typeof g.fontChar !== 'string' ||
            !Array.isArray(g.bounds) ||
            g.bounds.length !== 4 ||
            !g.bounds.every(Number.isFinite)
        )
      )
        return
      const token = tableTextToken(raw, v, 0),
        fontRect = nativeFigureLabelBounds(raw, style, v)
      if (
        !token.horizontal ||
        !valid(token.rect) ||
        !same(token.rect, matches[0].rect) ||
        !valid(fontRect)
      )
        return
      return { token, fontRect }
    }
    const conflicts = tables.filter((table) => {
      if (
        table?.page !== page.pageNumber ||
        table.readingRotation ||
        table.parts?.length ||
        table.nativeBody ||
        !valid(table.region) ||
        !valid(table.cropRect) ||
        !table.thumbnail ||
        !Array.isArray(table.issues) ||
        !(
          (table.reviewCandidate === true && table.issues.length === 0) ||
          // Suspending the logical cell mapping does not give a figure the
          // independently captioned table's complete native body. Every
          // source, font, unique-owner and boundary check below still applies.
          (table.reviewCandidate === false &&
            table.issues.length === 1 &&
            table.issues[0] === 'native-table-structure-ambiguous')
        ) ||
        !Array.isArray(table.unassigned) ||
        table.unassigned.length ||
        !Array.isArray(table.clipped) ||
        table.clipped.length ||
        !Array.isArray(table.cells) ||
        !table.cells.length ||
        captionKind(table.caption?.lines?.[0] ?? '') !== 'table' ||
        table.caption.page !== page.pageNumber ||
        !valid(table.caption.rect) ||
        intersects(table.caption.rect, body) ||
        intersects(table.caption.rect, figure.caption.rect) ||
        table.sourceViewport?.scale !== 1.5 ||
        table.sourceViewport.width !== page.width * 1.5 ||
        table.sourceViewport.height !== page.height * 1.5
      )
        return false
      const region = table.region.map((n, i) => n * (i % 2 ? page.height : page.width)),
        crop = table.cropRect.map((n) => n / 1.5),
        claims = [],
        seen = new Set()
      if (
        !inside([0, 0, page.width, page.height], region) ||
        !inside(region, crop) ||
        table.caption.rect[3] >= region[1] ||
        figure.caption.rect[1] <= region[3]
      )
        return false
      for (const cell of table.cells) {
        if (
          cell.text === '' &&
          absentOrEmpty(cell.sourceItems) &&
          absentOrEmpty(cell.sourceRects) &&
          absentOrEmpty(cell.sourceSegments)
        )
          continue
        if (
          !Array.isArray(cell.sourceItems) ||
          !Array.isArray(cell.sourceRects) ||
          !absentOrEmpty(cell.sourceSegments) ||
          cell.sourceItems.length !== cell.sourceRects.length ||
          typeof cell.text !== 'string' ||
          compact(cell.sourceItems.map((s) => s.text).join('')) !== compact(cell.text)
        )
          return false
        for (const [i, source] of cell.sourceItems.entries()) {
          const proof = bound(source)
          if (
            !proof ||
            seen.has(source.index) ||
            !same(
              cell.sourceRects[i],
              proof.token.rect.map((n) => n * 1.5)
            ) ||
            !inside(region, proof.token.rect) ||
            !inside(crop, proof.token.rect) ||
            !inside(body, proof.token.rect) ||
            !inside(body, proof.fontRect)
          )
            return false
          seen.add(source.index)
          claims.push(source)
        }
      }
      if (!claims.length || table.selectedTextItems !== claims.length) return false
      const nativeBody = content.items.flatMap((r) => {
        if (typeof r.str !== 'string' || !r.str.trim()) return []
        const token = tableTextToken(r, v, 0)
        return valid(token.rect) && intersects(region, token.rect) ? [r] : []
      })
      if (
        nativeBody.length !== claims.length ||
        nativeBody.some((r) => !seen.has(r.sourceItem?.index))
      )
        return false
      const title = tokens.filter((t) => inside(table.caption.rect, t.rect))
      if (
        !title.length ||
        compact(title.map((t) => t.text).join('')) !== compact(table.caption.lines.join('')) ||
        title.some((t) => !bound(t.sourceItem)) ||
        new Set(title.map((t) => t.sourceItem.index)).size !== title.length ||
        title.some((t) => seen.has(t.sourceItem.index))
      )
        return false
      return true
    })
    if (conflicts.length !== 1) return figure
    const refused = { ...figure, issue: 'no-unambiguous-adjacent-graphics' }
    delete refused.region
    delete refused.thumbnail
    return refused
  } catch {
    return figure
  }
}
