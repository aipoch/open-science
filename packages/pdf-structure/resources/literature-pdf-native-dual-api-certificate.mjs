/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual as same } from 'node:util'
import { version } from 'pdfjs-dist/legacy/build/pdf.mjs'

// Explicit same-render caller certificate. It never substitutes source strings.
export function verifyNativeDualApiCertificate(page, context, evidence) {
  const a = evidence?.defaultContent,
    b = evidence?.rawContent,
    p = evidence?.renderContext
  if (
    evidence?.schema !== 'same-pdfjs-page-dual-api-capture-v1' ||
    evidence.pdfjsVersion !== version ||
    !same(evidence.apiDefaultOptions, {}) ||
    !same(evidence.apiRawOptions, { disableNormalization: true }) ||
    evidence.pageNumber !== page?.pageNumber ||
    context?.pageNumber !== page.pageNumber ||
    p?.pageNumber !== page.pageNumber ||
    evidence.sourceSha256 !== context.sourceSha256 ||
    p.sourceSha256 !== context.sourceSha256 ||
    !/^[a-f\d]{64}$/u.test(context.sourceSha256) ||
    !Array.isArray(a?.items) ||
    !Array.isArray(b?.items) ||
    !a.items.length ||
    a.items.length > 4096 ||
    a.items.length !== b.items.length ||
    a.items.length !== context.content?.items?.length ||
    !same(a.styles, b.styles) ||
    !same(a.styles, context.content.styles) ||
    !same(a.styles, p.content?.styles)
  )
    return
  const viewport = { ...context.viewport }
  delete viewport.convertToViewportPoint
  if (
    !same(p.viewport, viewport) ||
    !same(p.operators, context.operators) ||
    !same(p.glyphBounds, context.glyphBounds) ||
    !same(p.opaqueRasterImages, context.opaqueRasterImages) ||
    !same(p.graphicsBounds, context.graphicsBounds) ||
    !same(page.graphicsBounds, p.graphicsBounds)
  )
    return
  const am = { ...a },
    bm = { ...b }
  delete am.items
  delete bm.items
  if (!same(am, bm)) return
  const differences = new Map()
  for (let index = 0; index < a.items.length; index++) {
    const x = { ...a.items[index] },
      y = { ...b.items[index] },
      z = { ...context.content.items[index] },
      paint = { ...p.content.items[index] },
      normal = x.str,
      raw = y.str
    delete z.sourceItem
    if (!same(x, z) || !same(x, paint)) return
    delete x.str
    delete y.str
    if (!same(x, y) || typeof normal !== 'string' || typeof raw !== 'string') return
    if (normal !== raw) {
      if (normal !== 'μ' || raw !== 'µ') return
      differences.set(index, { normal, raw })
    }
  }
  return differences.size ? differences : undefined
}

export function completeNativeDualApiPacket(packet, certificate) {
  if (!packet || !certificate || packet.records.some((record) => !record.advanceComplete)) return
  return completeScopedNativeDualApiPacket(packet, certificate)
}

// The caller must separately require a whole advance for every claimed source.
// Foreign records and their physical glyph ownership are still all retained.
export function completeScopedNativeDualApiPacket(packet, certificate) {
  if (!packet || !certificate) return
  const owners = new Map(),
    records = new Map(packet.records.map((r) => [r.index, r]))
  for (const record of packet.records) {
    for (const glyph of new Set(record.part.map((z) => z.g))) {
      if (owners.has(glyph) && owners.get(glyph) !== record) return
      owners.set(glyph, record)
    }
  }
  for (const [index, pair] of certificate) {
    const record = records.get(index),
      glyphs = record && [...new Set(record.part.map((z) => z.g))]
    if (!record?.advanceComplete || glyphs.length !== 1 || record.r.str !== pair.normal) return
    const glyph = glyphs[0]
    const rawGlyph = packet.o.argsArray[glyph.i]?.[0]?.filter(
      (g) => g && typeof g === 'object' && typeof g.unicode === 'string'
    )[glyph.show.glyphs.indexOf(glyph)]
    if (
      glyph.text !== pair.raw ||
      !Number.isFinite(glyph.advance?.[2]) ||
      !(glyph.advance[2] > glyph.advance[0]) ||
      glyph.rendererSkipped ||
      !Number.isSafeInteger(rawGlyph?.originalCharCode) ||
      rawGlyph.originalCharCode < 0 ||
      typeof rawGlyph.fontChar !== 'string' ||
      !rawGlyph.fontChar ||
      !(rawGlyph.width > 0) ||
      !Number.isFinite(rawGlyph.width)
    )
      return
  }
  return packet
}
