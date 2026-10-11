/* eslint-disable @typescript-eslint/explicit-function-return-type -- Worker-private native proof. */

// Read-only proof for PDFs whose paint order differs from their visual order.
// Never use this spelling to delete/repaint objects: it can include bounded parts
// of shared runs. The caller must reserve the entire unchanged region.
export function nativeReadingOrder(e, page, rect) {
  const p = e.p,
    text = p.FPDFText_LoadPage(page)
  if (!text) return undefined
  const at = e.alloc(48)
  try {
    const count = p.FPDFText_CountChars(text)
    if (count < 0 || count > 100000) return undefined
    const glyphs = [],
      objects = new Map()
    for (let i = 0; i < count; i++) {
      const code = p.FPDFText_GetUnicode(text, i)
      if (!code || /\s/u.test(String.fromCodePoint(code))) continue
      if (!p.FPDFText_GetCharBox(text, i, at, at + 8, at + 16, at + 24)) return undefined
      const [left, right, bottom, top] = e.m.HEAPF64.slice(at / 8, at / 8 + 4)
      if (![left, right, bottom, top].every(Number.isFinite)) return undefined
      if (
        right <= rect.x ||
        left >= rect.x + rect.width ||
        top <= rect.bottom ||
        bottom >= rect.top
      )
        continue
      // Require complete glyphs, with the same horizontal ink allowance as the
      // native object preflight. Do not clip a neighboring row or script.
      if (
        left < rect.x - 2 ||
        right > rect.x + rect.width + 2 ||
        bottom < rect.bottom - 0.05 ||
        top > rect.top + 0.05
      )
        return undefined
      const object = p.FPDFText_GetTextObject(text, i)
      if (!objects.has(object)) {
        if (!object || !p.FPDFPageObj_GetMatrix(object, at)) return undefined
        const [a, b, c, d] = e.m.HEAPF32.slice(at / 4, at / 4 + 4)
        objects.set(object, a > 0 && d > 0 && Math.abs(b) < 0.000001 && Math.abs(c / d) <= 0.3)
      }
      if (!objects.get(object) || !p.FPDFText_GetCharOrigin(text, i, at, at + 8)) return undefined
      const [x, baseline] = e.m.HEAPF64.slice(at / 8, at / 8 + 2)
      if (![x, baseline].every(Number.isFinite) || /\p{C}/u.test(String.fromCodePoint(code)))
        return undefined
      glyphs.push({ i, text: String.fromCodePoint(code), x, baseline, top, bottom })
      if (glyphs.length > 4096) return undefined
    }
    // Establish body rows first, then attach only nearby, horizontally distinct
    // raised/lowered glyphs. Stacked fractions and overlapping scripts are not a
    // linear reading-order proof.
    const rows = []
    for (const glyph of glyphs.toSorted(
      (a, b) => b.top - b.bottom - (a.top - a.bottom) || a.i - b.i
    )) {
      const matches = rows.filter(
        (row) => Math.abs(row.baseline - glyph.baseline) <= row.height * 0.75
      )
      if (matches.length > 1) return undefined
      if (matches.length) matches[0].glyphs.push(glyph)
      else
        rows.push({ baseline: glyph.baseline, height: glyph.top - glyph.bottom, glyphs: [glyph] })
    }
    const ordered = rows
      .toSorted((a, b) => b.baseline - a.baseline)
      .flatMap((row) => {
        return row.glyphs.toSorted((a, b) => a.x - b.x || a.i - b.i)
      })
    for (const row of rows) {
      const sorted = row.glyphs.toSorted((a, b) => a.x - b.x)
      if (sorted.some((glyph, i) => i > 0 && glyph.x - sorted[i - 1].x < 0.01)) return undefined
    }
    // This fallback repairs ordering only. Ordinary missing/extra/cropped text
    // must continue through the existing strict source checks.
    if (!ordered.some((glyph, i) => glyph.i !== glyphs[i].i)) return undefined
    return ordered.map((glyph) => glyph.text).join('')
  } finally {
    e.free(at)
    p.FPDFText_ClosePage(text)
  }
}
