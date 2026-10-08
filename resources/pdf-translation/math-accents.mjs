/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled worker helper. */
// Computer Modern's extension-font slots 98/101 are a wide circumflex/tilde.
// PDFium can report their legacy encodings as "b"/"e", whereas PDF.js resolves
// the accent. Never reinterpret prose: require the extension font and geometry,
// centered above exactly one separate mathematical base glyph.
// CMR's spacing circumflex has narrower ink, but still needs that same
// unique raised-base proof; an ordinary inline circumflex is not an accent.
export const resolveNativeMathAccents = (objects) => {
  const result = []
  const used = new Set()
  for (const accent of objects) {
    const macron =
        accent.text.trim() === '¯' &&
        /^(?:[A-Z]{6}\+)?CMR(?:7|8|9|10|12)$/u.test(accent.fontName ?? ''),
      narrowHat =
        accent.text.trim() === 'ˆ' &&
        /^(?:[A-Z]{6}\+)?CMR(?:7|8|9|10|12)$/u.test(accent.fontName ?? ''),
      tilde =
        accent.text.trim() === 'e' &&
        /^(?:[A-Z]{6}\+)?CMEX(?:7|8|9|10|12)$/u.test(accent.fontName ?? '')
    if (
      !macron &&
      !narrowHat &&
      !tilde &&
      (accent.text.trim() !== 'b' ||
        !/^(?:[A-Z]{6}\+)?CMEX(?:7|8|9|10|12)$/u.test(accent.fontName ?? ''))
    )
      continue
    const [left, bottom, right, top] = accent.bounds,
      width = right - left,
      height = top - bottom
    if (width <= 0 || height <= 0 || height >= width * (narrowHat ? 0.8 : 0.45)) continue
    const bases = objects.flatMap((base) => {
      if (
        base.i === accent.i ||
        !/^(?:[A-Z]{6}\+)?(?:CMMI|CMMIB|CMTI|CMR|CMBX|CMSY)(?:7|8|9|10|12)$/u.test(
          base.fontName ?? ''
        )
      )
        return []
      // A PDF text object can contain both the accented variable and punctuation.
      // Only native character bounds may select a base inside a larger object;
      // the complete object remains owned and moves with the accent.
      const glyphs =
        base.glyphs ??
        (/^[A-Za-z\p{Script=Greek}]$/u.test(base.text.trim())
          ? [
              {
                text: base.text.trim(),
                offset: base.text.indexOf(base.text.trim()),
                bounds: base.bounds
              }
            ]
          : [])
      return glyphs.flatMap((glyph) => {
        if (
          !/^[A-Za-z\p{Script=Greek}]$/u.test(glyph.text) ||
          base.text.slice(glyph.offset, glyph.offset + glyph.text.length) !== glyph.text
        )
          return []
        const [x, y, end, upper] = glyph.bounds,
          baseWidth = end - x,
          baseHeight = upper - y,
          // The italic f descends to the left; its macron centers on the
          // ascender, not on the full ink box including that descender.
          skew =
            macron && glyph.text === 'f' && /CMMI/u.test(base.fontName ?? '') ? baseWidth * 0.25 : 0
        // CMR's spacing macron has fixed thin ink; an italic capital can be
        // much wider. Its actual, equal native font sizes provide a second
        // proof, rather than accepting arbitrary narrow marks or wider bases.
        const shortMacron =
          macron &&
          /^[A-Z]$/u.test(glyph.text) &&
          /^(?:[A-Z]{6}\+)?CMMI(?:7|8|9|10|12)$/u.test(base.fontName ?? '') &&
          accent.size > 0 &&
          Math.abs(base.size - accent.size) < accent.size * 0.01 &&
          width > accent.size * 0.34 &&
          width < accent.size * 0.38 &&
          height > accent.size * 0.02 &&
          height < accent.size * 0.04 &&
          baseWidth > base.size * 0.65 &&
          baseWidth < base.size * 0.8 &&
          baseHeight > base.size * 0.65 &&
          baseHeight < base.size * 0.75
        return baseHeight > height * 1.5 &&
          (shortMacron || width >= baseWidth * (narrowHat ? 0.2 : 0.6)) &&
          width <= baseWidth * (narrowHat ? 0.8 : 1.8) &&
          Math.abs((left + right - x - end) / 2 - skew) < baseWidth * 0.25 &&
          bottom >= upper - height * 0.2 &&
          bottom - upper < baseHeight * 0.5
          ? [{ base, glyph }]
          : []
      })
    })
    if (bases.length !== 1 || used.has(bases[0].base.i)) continue
    const { base, glyph } = bases[0]
    used.add(base.i)
    const before = base.text.slice(0, glyph.offset),
      after = base.text.slice(glyph.offset + glyph.text.length),
      mark = macron ? '¯' : narrowHat ? 'ˆ' : tilde ? '˜' : '\u0302',
      label = (before + glyph.text + mark + after).trim(),
      leading = (before + mark + glyph.text + after).trim()
    result.push({
      indices: [accent.i, base.i].sort((a, b) => a - b),
      accentIndex: accent.i,
      baseIndex: base.i,
      label,
      labels: [label, leading],
      bounds: [
        Math.min(left, base.bounds[0]),
        Math.min(bottom, base.bounds[1]),
        Math.max(right, base.bounds[2]),
        Math.max(top, base.bounds[3])
      ]
    })
  }
  return result
}

// A publisher can paint a Latin dieresis separately from its vowel. Resolve
// only the uniquely owned native glyph, never an inferred word or text order.
export const resolveNativeLatinAccents = (objects) => {
  const result = [],
    used = new Set()
  for (const accent of objects) {
    if (
      accent.text.trim() !== '¨' ||
      !accent.fontIdentity ||
      !(accent.size > 0) ||
      /(?:TeX-math|CM(?:MI|SY|EX))/u.test(accent.fontName ?? '')
    )
      continue
    const [left, bottom, right, top] = accent.bounds,
      width = right - left,
      height = top - bottom
    if (width <= 0 || height <= 0 || height >= width * 0.45) continue
    const bases = objects.flatMap((base) => {
      if (
        base.i === accent.i ||
        base.fontIdentity !== accent.fontIdentity ||
        base.fontName !== accent.fontName ||
        base.size !== accent.size
      )
        return []
      return (base.glyphs ?? [])
        .filter((glyph) => {
          if (
            !/^[AEIOUYaeiouy]$/u.test(glyph.text) ||
            base.text.slice(glyph.offset, glyph.offset + 1) !== glyph.text
          )
            return false
          const [x, y, end, upper] = glyph.bounds,
            baseWidth = end - x,
            baseHeight = upper - y
          return (
            x >= base.bounds[0] &&
            y >= base.bounds[1] &&
            end <= base.bounds[2] &&
            upper <= base.bounds[3] &&
            baseHeight > height * 1.5 &&
            width >= baseWidth * 0.4 &&
            width <= baseWidth * 1.2 &&
            Math.abs((left + right - x - end) / 2) < baseWidth * 0.2 &&
            bottom >= upper &&
            bottom - upper < baseHeight * 0.5
          )
        })
        .map((glyph) => ({ base, glyph }))
    })
    if (bases.length !== 1) continue
    const { base, glyph } = bases[0],
      key = `${base.i}:${glyph.offset}`
    if (used.has(key)) continue
    used.add(key)
    result.push({
      indices: [accent.i, base.i],
      accentIndex: accent.i,
      baseIndex: base.i,
      offset: glyph.offset,
      letter: (glyph.text + '\u0308').normalize('NFC')
    })
  }
  return result
}
