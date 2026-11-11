/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-orientation.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const same = (a, b) => a?.length === b?.length && a.every((n, i) => Math.abs(n - b[i]) < 1e-7)
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-7 : n <= a[i] + 1e-7))
const compact = (s) => s.normalize('NFD').replace(/\s/gu, '')
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]

// A private shape selector under the caller's existing, current pixel certificate.
// Original whole fonts split a BT that can also contain the main caption/folio;
// neither a synthetic ET nor a Source claim is created.
export function nativeVerticalSubcaptionFormFamily(
  data,
  items,
  figure,
  captions,
  page,
  tokens,
  context
) {
  if (
    !Array.isArray(data?.scopes) ||
    !Array.isArray(data.pieces) ||
    !Array.isArray(items) ||
    items.length > 16384 ||
    !Array.isArray(captions) ||
    captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
    captions[0] !== figure.caption ||
    !valid(figure.rect) ||
    !valid(figure.caption.rect) ||
    items.some((p) => !valid(p.bound))
  )
    return
  const source = nativePageTextPacketInventory(
    page,
    tokens,
    context,
    true,
    new Set(tokens.map((t) => t.sourceItem?.index))
  )
  if (!source) return
  const forms = data.scopes
    .filter(
      (s) =>
        s.op === OPS.paintFormXObjectBegin &&
        !data.scopes.some(
          (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
        )
    )
    .sort((a, b) => a.begin - b.begin)
  if (forms.length !== 3) return
  const roots = forms
    .map((scope) => ({
      scope,
      parts: items.filter((p) => p.operationIndex > scope.begin && p.operationIndex < scope.end)
    }))
    .map((r) => ({ ...r, bound: r.parts.length && union(r.parts.map((p) => p.bound)) }))
  const caption = figure.caption
  if (
    roots.some(
      (r, i) =>
        !Number.isSafeInteger(r.scope.begin) ||
        !Number.isSafeInteger(r.scope.end) ||
        r.scope.begin >= r.scope.end ||
        !valid(r.bound) ||
        r.bound[3] >= caption.rect[1] ||
        !r.parts.some((p) => p.kind === 'path') ||
        !r.parts.some((p) => p.kind === 'glyph') ||
        r.parts.some((p) => !['path', 'glyph'].includes(p.kind)) ||
        (i && (r.scope.begin <= roots[i - 1].scope.end || r.bound[1] <= roots[i - 1].bound[3]))
    )
  )
    return
  const glyphs = items.filter((p) => p.kind === 'glyph'),
    recordParts = new Map(),
    recordClaims = new Map()
  for (const r of source.records) {
    const parts = []
    for (const { g } of r.part) {
      const matches = glyphs.filter(
        (p) =>
          p.operationIndex === g.i &&
          p.fontName === g.fontName &&
          p.text === g.text &&
          same(p.advance, g.advance) &&
          same(p.fullInk, g.ink)
      )
      if (matches.length !== 1) return
      if (!parts.includes(matches[0])) parts.push(matches[0])
    }
    const claims = tokens.filter((t) => t.sourceItem?.index === r.index)
    if (
      r.r !== context.content.items[r.index] ||
      r.r.sourceItem?.index !== r.index ||
      r.r.sourceItem.pageNumber !== page.pageNumber ||
      r.r.sourceItem.text !== r.r.str ||
      compact(r.part.map((p) => p.c).join('')) !== compact(r.r.str) ||
      claims.length > 1 ||
      claims.some(
        (t) =>
          t.text !== r.r.str ||
          t.sourceItem.text !== r.r.str ||
          t.sourceItem.pageNumber !== page.pageNumber
      )
    )
      return
    recordParts.set(r, parts)
    recordClaims.set(r, claims)
  }
  const originalInk = (p) =>
    p.fillAlpha === 1 &&
    /^#[a-f0-9]{6}$/iu.test(p.fillColor ?? '') &&
    p.fillColor.toLowerCase() !== '#ffffff' &&
    p.potentialClipEnvelope === undefined &&
    p.originalClipQuads === undefined &&
    valid(p.paintClip) &&
    inside(p.paintClip, p.fullInk) &&
    inside(p.paintClip, p.advance)
  const own = [],
    claimed = new Set()
  for (const [i, root] of roots.entries()) {
    const bottom = roots[i + 1]?.bound[1] ?? caption.rect[1]
    const records = source.records.filter(
      (r) =>
        r.rect[1] >= root.bound[3] - 2 &&
        r.rect[3] < bottom &&
        recordParts
          .get(r)
          .every(
            (p) =>
              p.operationIndex > root.scope.end &&
              p.operationIndex < (roots[i + 1]?.scope.begin ?? Infinity)
          )
    )
    if (
      !records.length ||
      !new RegExp('^\\(' + String.fromCharCode(97 + i) + '\\)\\s+\\S', 'u').test(
        records[0].r.str
      ) ||
      records
        .slice(1)
        .some((r) =>
          /^\([a-z]\)|^(?:Fig(?:ure)?\.?|Tables?|Notes?|Sources?|Algorithms?|Procedures?)\s/iu.test(
            r.r.str
          )
        ) ||
      !/[.!?]$/u.test(records.at(-1).r.str)
    )
      return
    const parts = records.flatMap((r) => recordParts.get(r)),
      first = parts[0],
      bound = union(parts.map((p) => p.bound)),
      em = records[0].r.height
    if (
      !(em > 0) ||
      bound[1] < root.bound[3] - 2 ||
      bound[1] - root.bound[3] > em * 2 ||
      bound[0] < caption.rect[0] - em ||
      bound[2] > caption.rect[2] + em ||
      parts.some(
        (p) =>
          !originalInk(p) ||
          claimed.has(p) ||
          p.packetBegin !== first.packetBegin ||
          p.packetEnd !== first.packetEnd
      )
    )
      return
    for (const p of parts) claimed.add(p)
    own.push(...root.parts, ...parts)
  }
  const capRecords = source.records.filter((r) => hit(r.rect, caption.rect))
  if (
    !capRecords.length ||
    capRecords.some(
      (r) =>
        recordClaims.get(r).length !== 1 ||
        !r.rect.every((n, i) => (i < 2 ? n >= caption.rect[i] - 0.02 : n <= caption.rect[i] + 0.02))
    ) ||
    compact(capRecords.map((r) => r.r.str).join('')) !== compact(caption.lines.join('')) ||
    capRecords.flatMap((r) => recordParts.get(r)).some((p) => !originalInk(p))
  )
    return
  const rect = union(own.map((p) => p.bound)).map((n, i) => n + (i < 2 ? -2 / 1.5 : 2 / 1.5)),
    set = new Set(own),
    foreign = items.filter((p) => !set.has(p))
  const used = source.records.filter((r) => recordParts.get(r).some((p) => set.has(p)))
  if (
    used.some(
      (r) =>
        recordClaims.get(r).length !== 1 ||
        r.advanceComplete !== true ||
        !recordParts.get(r).every((p) => set.has(p))
    ) ||
    !hit(rect, figure.rect) ||
    captions.some((c) => hit(rect, c.rect)) ||
    foreign.some((p) =>
      hit(
        rect,
        p.bound.map((n, i) => n + (i < 2 ? -2 / 1.5 : 2 / 1.5))
      )
    ) ||
    source.records
      .filter((r) => !used.includes(r))
      .some((r) => {
        const font = nativeFigureLabelBounds(
          r.r,
          context.content.styles[r.r.fontName],
          context.viewport
        )
        return !valid(font) || hit(rect, font)
      })
  )
    return
  return { own, kind: 'complete-native-subcaption-family' }
}
