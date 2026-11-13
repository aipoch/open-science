/* eslint-disable @typescript-eslint/explicit-function-return-type -- Worker-only source recovery. */
// Re-read exact item identities only after ordinary native proof fails. Keep one
// lazy PDF.js document per generation; neither saved snapshots nor ink change.
export function createSourceFragmentRecovery(data, pages) {
  let loading
  const recover = async (unit) => {
    if (!unit.fragments.every((fragment) => Array.isArray(fragment.items) && fragment.items.length))
      return
    if (!loading) {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      loading = getDocument({ data: data.slice(), useSystemFonts: true, fontExtraProperties: true })
    }
    const document = await loading.promise
    const fragments = []
    let recovered = false
    for (const fragment of unit.fragments) {
      const items = fragment.items
      if (!items?.length || items.length > 500) return
      const page = await document.getPage(fragment.pageNumber)
      const size = pages[fragment.pageNumber - 1]
      const viewport = page.getViewport({ scale: 1 })
      if (
        viewport.rotation ||
        viewport.transform.slice(0, 4).some((value, index) => value !== [1, 0, 0, -1][index]) ||
        viewport.transform[4] !== 0 ||
        viewport.transform[5] !== size.height ||
        Math.abs(viewport.width - size.width) > 0.01 ||
        Math.abs(viewport.height - size.height) > 0.01
      )
        return
      const content = await page.getTextContent()
      const owned = new Set(items.map((item) => item.index))
      if (owned.size !== items.length) return
      for (const [offset, item] of items.entries()) {
        const raw = content.items[item.index]
        if (
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          (offset && item.index <= items[offset - 1].index) ||
          raw?.str !== item.text
        )
          return
      }
      // Even contiguous items can have an oversized aggregate advance box.
      // Retry their independently re-read boxes; native preflight must still
      // prove every item's complete text and the aggregate source sequence.
      for (const item of items) {
        const raw = content.items[item.index]
        const [a, b, c, d, x, baseline] = raw.transform
        if (raw.dir !== 'ltr' || a <= 0 || d <= 0 || b !== 0 || c !== 0 || raw.width <= 0) return
        // Same upright em-box convention as reader/layout.ts. Native glyph
        // preflight below remains authoritative for actual painted bounds.
        const rect = {
          x: x / size.width,
          y: (size.height - baseline - d * 0.85) / size.height,
          width: raw.width / size.width,
          height: (d * 1.1) / size.height
        }
        const old = fragment.rect
        // An item ID never authorizes moving an unrelated source rectangle.
        if (
          !Object.values(rect).every(Number.isFinite) ||
          rect.x < old.x - 0.05 / size.width ||
          rect.y < old.y - 0.05 / size.height ||
          rect.x + rect.width > old.x + old.width + 0.05 / size.width ||
          rect.y + rect.height > old.y + old.height + 0.05 / size.height
        )
          return
        fragments.push({ ...fragment, rect, items: [item] })
      }
      recovered = true
    }
    if (recovered && fragments.length <= 500) return { ...unit, fragments }
  }
  return {
    async recover(unit) {
      try {
        return await recover(unit)
      } catch {
        // PDF.js is optional evidence. Its parse/extraction failure must not
        // replace the native source failure or the existing retention policy.
        return undefined
      }
    },
    async originalTextOrigins(e, page, objects, pageNumber, resources) {
      try {
        const { PDFName, PDFDict, PDFRawStream } = await import('pdf-lib')
        const { createHash } = await import('node:crypto')
        const { inflateSync } = await import('node:zlib')
        if (!loading) {
          const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
          loading = getDocument({
            data: data.slice(),
            useSystemFonts: true,
            fontExtraProperties: true
          })
        }
        const original = await (await loading.promise).getPage(pageNumber)
        const viewport = original.getViewport({ scale: 1 }),
          size = pages[pageNumber - 1]
        if (viewport.rotation || viewport.width !== size.width || viewport.height !== size.height)
          return
        const content = await original.getTextContent(),
          ops = await original.getOperatorList()
        if (
          content.items.length > 10000 ||
          ops.fnArray.length > 100000 ||
          ops.fnArray.length !== ops.argsArray.length
        )
          return
        const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
        const hash = (b) => createHash('sha256').update(b).digest('hex')
        const fonts = resources?.lookup(PDFName.of('Font'))
        if (!(fonts instanceof PDFDict)) return
        const profiles = new Map(),
          byFont = new Map(),
          stack = []
        let font = '',
          fontSize = 0,
          forms = 0,
          charSpacing = 0,
          wordSpacing = 0,
          hscale = 100,
          rise = 0,
          rendering = 0
        for (let i = 0; i < ops.fnArray.length; i++) {
          const op = ops.fnArray[i],
            a = ops.argsArray[i]
          if (op === OPS.setFont) {
            font = a[0]
            fontSize = a[1]
          } else if (op === OPS.setGState && a?.[0]?.some((entry) => entry?.[0] === 'Font')) return
          else if (op === OPS.setCharSpacing) charSpacing = a[0]
          else if (op === OPS.setWordSpacing) wordSpacing = a[0]
          else if (op === OPS.setHScale) hscale = a[0]
          else if (op === OPS.setTextRise) rise = a[0]
          else if (op === OPS.setTextRenderingMode) rendering = a[0]
          else if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) {
            stack.push({ font, fontSize, forms, charSpacing, wordSpacing, hscale, rise, rendering })
            if (op === OPS.paintFormXObjectBegin || op === OPS.beginGroup) forms++
          } else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
            if (!stack.length) return
            ;({ font, fontSize, forms, charSpacing, wordSpacing, hscale, rise, rendering } =
              stack.pop())
          } else if (op === OPS.showText && !forms && Array.isArray(a?.[0])) {
            const f = original.commonObjs.get(font)
            if (!profiles.has(font)) {
              let profile
              if (
                f?.loadedName === font &&
                f.missingFile === false &&
                f.isType3Font === false &&
                f.isInvalidPDFjsFont === false &&
                f.vertical === false &&
                !f.remeasure &&
                f.type === 'Type1' &&
                JSON.stringify(f.fontMatrix) === '[0.001,0,0,0.001,0,0]'
              ) {
                const matches = fonts
                  .values()
                  .map((ref) => fonts.context.lookup(ref))
                  .filter(
                    (raw) =>
                      raw instanceof PDFDict &&
                      raw.get(PDFName.of('BaseFont'))?.toString() === '/' + f.name
                  )
                if (matches.length === 1) {
                  const descriptor = matches[0].lookup(PDFName.of('FontDescriptor'))
                  const files = ['FontFile', 'FontFile3']
                    .map((k) => descriptor?.lookup(PDFName.of(k)))
                    .filter(Boolean)
                  if (files.length === 1 && files[0] instanceof PDFRawStream) {
                    const encoded = files[0].getContents(),
                      filter = files[0].dict.lookup(PDFName.of('Filter')),
                      limit = 32 * 1024 ** 2
                    const bytes =
                      encoded.length <= limit && !files[0].dict.has(PDFName.of('DecodeParms'))
                        ? !filter
                          ? encoded
                          : filter.toString() === '/FlateDecode'
                            ? inflateSync(encoded, { maxOutputLength: limit })
                            : undefined
                        : undefined
                    if (bytes?.length > 0 && bytes.length <= limit)
                      profile = { name: f.name.replace(/^[A-Z]{6}\+/u, ''), sha256: hash(bytes) }
                  }
                }
              }
              profiles.set(font, profile)
            }
            const list = byFont.get(font) ?? [],
              raw = a[0]
            const literal = raw
              .filter((g) => typeof g !== 'number')
              .map((g) => g?.unicode ?? '')
              .join('')
            const eligible =
              profiles.get(font) &&
              Number.isFinite(fontSize) &&
              fontSize > 0 &&
              raw.every((g) =>
                typeof g === 'number'
                  ? Number.isFinite(g)
                  : typeof g?.unicode === 'string' &&
                    /^[\x20-\x7e]+$/u.test(g.unicode) &&
                    g.isInFont === true &&
                    g.accent == null &&
                    g.vmetric == null &&
                    g.operatorListId == null &&
                    Number.isFinite(g.width) &&
                    g.width >= 0
              )
            const inner = [...raw]
            list.push({
              literal,
              eligible:
                eligible &&
                [...literal].length === 1 &&
                !/[\s\p{C}\p{M}]/u.test(literal) &&
                charSpacing === 0 &&
                wordSpacing === 0 &&
                hscale === 100 &&
                rise === 0 &&
                rendering === 0 &&
                inner.length === 1 &&
                typeof inner[0] !== 'number',
              size: fontSize,
              signature: JSON.stringify(
                inner.map((g) => (typeof g === 'number' ? g : [g.unicode, g.fontChar, g.width]))
              )
            })
            byFont.set(font, list)
          }
        }
        if (stack.length) return
        const programs = new Map()
        for (const [font, runs] of byFont) {
          const profile = profiles.get(font)
          if (!profile) continue
          for (const literal of new Set(runs.filter((x) => x.eligible).map((x) => x.literal))) {
            const same = runs.filter((x) => x.literal.includes(literal))
            const items = content.items.filter(
              (item) => 'str' in item && item.fontName === font && item.str.includes(literal)
            )
            if (
              same.length !== items.length ||
              !same.every((x) => x.eligible && x.literal === literal) ||
              items.some(
                (x, i) =>
                  x.str !== literal ||
                  x.dir !== 'ltr' ||
                  x.transform[1] !== 0 ||
                  x.transform[2] !== 0 ||
                  Math.fround(x.transform[0]) !== Math.fround(same[i].size) ||
                  Math.fround(x.transform[3]) !== Math.fround(same[i].size)
              )
            )
              continue
            same.forEach((run, i) => {
              const k = JSON.stringify([
                profile.name,
                profile.sha256,
                Math.fround(run.size),
                literal
              ])
              programs.set(k, [
                ...(programs.get(k) ?? []),
                { ...run, point: items[i].transform.slice(4) }
              ])
            })
          }
        }
        const p = e.p,
          ptr = e.alloc(32),
          native = new Map(),
          fontCache = new Map()
        const textPage = p.FPDFText_LoadPage(page),
          glyphs = new Map()
        if (!textPage) {
          e.free(ptr)
          return
        }
        try {
          const count = p.FPDFText_CountChars(textPage)
          if (count < 0 || count > 100000) return
          for (let index = 0; index < count; index++) {
            const object = p.FPDFText_GetTextObject(textPage, index)
            if (object) glyphs.set(object, [...(glyphs.get(object) ?? []), index])
          }
          for (const object of objects) {
            if (
              object.type !== 1 ||
              glyphs.get(object.obj)?.length !== 1 ||
              [...object.text].length !== 1 ||
              /[\s\p{C}\p{M}]/u.test(object.text) ||
              p.FPDFPageObj_CountMarks(object.obj) !== 0 ||
              p.FPDFTextObj_GetTextRenderMode(object.obj) !== 0 ||
              !p.FPDFPageObj_GetIsActive(object.obj, ptr) ||
              !e.m.HEAP32[ptr / 4] ||
              p.FPDFClipPath_CountPaths(p.FPDFPageObj_GetClipPath(object.obj)) > 0 ||
              !p.FPDFPageObj_GetMatrix(object.obj, ptr)
            )
              continue
            const matrix = Array.from(e.m.HEAPF32.slice(ptr / 4, ptr / 4 + 6))
            if (!p.FPDFText_GetCharOrigin(textPage, glyphs.get(object.obj)[0], ptr, ptr + 8))
              continue
            const firstOrigin = Array.from(e.m.HEAPF64.slice(ptr / 8, ptr / 8 + 2))
            if (firstOrigin.some((value, index) => value !== matrix[index + 4])) continue
            if (
              matrix.slice(0, 4).some((v, i) => v !== [1, 0, 0, 1][i]) ||
              !p.FPDFTextObj_GetFontSize(object.obj, ptr)
            )
              continue
            const size = e.m.HEAPF32[ptr / 4],
              f = p.FPDFTextObj_GetFont(object.obj)
            if (!fontCache.has(f)) {
              const length = p.FPDFFont_GetBaseFontName(f, 0, 0)
              let profile
              if (length > 0 && length < 512) {
                const nameAt = e.alloc(length)
                try {
                  p.FPDFFont_GetBaseFontName(f, nameAt, length)
                  const name = Buffer.from(e.m.HEAPU8.slice(nameAt, nameAt + length - 1)).toString(
                    'utf8'
                  )
                  p.FPDFFont_GetFontData(f, 0, 0, ptr)
                  const n = e.m.HEAPU32[ptr / 4]
                  if (n > 0 && n <= 32 * 1024 ** 2) {
                    const bytesAt = e.alloc(n)
                    try {
                      if (p.FPDFFont_GetFontData(f, bytesAt, n, ptr))
                        profile = { name, sha256: hash(e.m.HEAPU8.slice(bytesAt, bytesAt + n)) }
                    } finally {
                      e.free(bytesAt)
                    }
                  }
                } finally {
                  e.free(nameAt)
                }
              }
              fontCache.set(f, profile)
            }
            const profile = fontCache.get(f)
            if (
              !profile ||
              !p.FPDFPageObj_GetFillColor(object.obj, ptr, ptr + 4, ptr + 8, ptr + 12)
            )
              continue
            const color = Array.from(e.m.HEAPU32.slice(ptr / 4, ptr / 4 + 4))
            if (color[3] !== 255 || color.slice(0, 3).every((v) => v === 255)) continue
            const k = JSON.stringify([profile.name, profile.sha256, Math.fround(size), object.text])
            native.set(k, [
              ...(native.get(k) ?? []),
              { object, matrix, font: f, text: object.text }
            ])
          }
          const result = new Map()
          for (const [k, candidates] of native) {
            const source = programs.get(k)
            if (
              !source ||
              source.length !== candidates.length ||
              source.length > 128 ||
              new Set(source.map((x) => x.signature)).size !== 1
            )
              continue
            candidates.forEach((candidate, i) => {
              const point = source[i].point,
                matrix = candidate.matrix
              if (
                point.every(Number.isFinite) &&
                Math.abs(point[0] - matrix[4]) <= 0.5 &&
                Math.abs(point[1] - matrix[5]) <= 0.01
              )
                result.set(candidate.object.obj, { ...candidate, point })
            })
          }
          return result
        } finally {
          p.FPDFText_ClosePage(textPage)
          e.free(ptr)
        }
      } catch {
        return undefined
      }
    },
    async close() {
      try {
        await loading?.destroy()
      } catch {
        // Attempt cleanup even after failed loading without replacing the
        // generation result (or its original native validation error).
      }
    }
  }
}
