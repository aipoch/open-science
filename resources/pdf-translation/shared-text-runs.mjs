/* eslint-disable @typescript-eslint/explicit-function-return-type -- Worker-only native helper. */

// Some table cells share one PDF text object with explicit glyph positioning.
// Split only simple Latin runs, retaining the native font, glyph origins and
// paint order. A pixel-identical native render is required before accepting it.
// Fully owned runs can also shed redundant clipping, but only when the
// unclipped glyphs paint identical pixels. Effective clips and complex fonts stay native.
export function splitSharedTextRuns(e, doc, page, regions) {
  // Citation hit areas must never participate in the existing table/prose
  // ownership or grouping rules. They have one independent glyph proof below.
  const rectangles = regions.filter((r) => !r.nativeCitation),
    citations = regions.filter((r) => r.nativeCitation),
    p = e.p,
    width = Math.ceil(p.FPDF_GetPageWidthF(page) * 2),
    height = Math.ceil(p.FPDF_GetPageHeightF(page) * 2)
  if (width * height > 16 * 1024 ** 2) return
  const candidates = e
    .objects(page)
    .filter(
      (o) =>
        o.type === 1 &&
        /^[\x20-\x7e\u2018\u2019]{1,512}$/u.test(o.text) &&
        (rectangles.some(
          (r) =>
            o.bounds[0] < r.x + r.width &&
            o.bounds[2] > r.x &&
            o.bounds[1] >= r.bottom - 2 &&
            o.bounds[3] <= r.top + 2 &&
            (o.bounds[0] < r.x - 2 ||
              o.bounds[2] > r.x + r.width + 2 ||
              p.FPDFClipPath_CountPaths(p.FPDFPageObj_GetClipPath(o.obj)) > 0)
        ) ||
          (/^,\d{1,3}\s*$/u.test(o.text) &&
            citations.some(
              (r) =>
                o.bounds[0] < r.x + r.width &&
                o.bounds[2] > r.x &&
                o.bounds[1] >= r.bottom - 2 &&
                o.bounds[3] <= r.top + 2
            )))
    )
  if (!candidates.length) return
  const render = () => {
    const bitmap = p.FPDFBitmap_Create(width, height, 1)
    if (!bitmap) throw Error('Could not verify shared text run')
    try {
      p.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)
      p.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0)
      const buffer = p.FPDFBitmap_GetBuffer(bitmap)
      return e.m.HEAPU8.slice(buffer, buffer + height * p.FPDFBitmap_GetStride(bitmap))
    } finally {
      p.FPDFBitmap_Destroy(bitmap)
    }
  }
  const restored = (value) => {
    if (!value) throw Error('Could not restore shared text run')
  }
  let changed = false
  const at = e.alloc(64)
  try {
    for (const object of candidates) {
      if (
        p.FPDFTextObj_GetTextRenderMode(object.obj) !== 0 ||
        p.FPDFPageObj_CountMarks(object.obj) !== 0 ||
        !p.FPDFPageObj_GetIsActive(object.obj, at) ||
        !e.m.HEAP32[at / 4] ||
        !p.FPDFPageObj_GetMatrix(object.obj, at)
      )
        continue
      const [a, b, c, d] = e.m.HEAPF32.slice(at / 4, at / 4 + 4)
      if (a <= 0 || b !== 0 || c !== 0 || d <= 0 || !p.FPDFTextObj_GetFontSize(object.obj, at))
        continue
      const size = e.m.HEAPF32[at / 4],
        font = p.FPDFTextObj_GetFont(object.obj)
      if (!font || !p.FPDFPageObj_GetFillColor(object.obj, at, at + 4, at + 8, at + 12)) continue
      const color = [...e.m.HEAPU32.slice(at / 4, at / 4 + 4)]
      if (color[3] !== 255) continue
      const text = p.FPDFText_LoadPage(page),
        chars = []
      if (!text) throw Error('Could not inspect shared text run')
      try {
        for (let i = 0; i < p.FPDFText_CountChars(text); i++) {
          if (p.FPDFText_GetTextObject(text, i) !== object.obj) continue
          const code = p.FPDFText_GetUnicode(text, i)
          if (code === 32) continue
          if (
            !/^[\x21-\x7e\u2018\u2019]$/u.test(String.fromCharCode(code)) ||
            !p.FPDFText_GetCharOrigin(text, i, at, at + 8)
          )
            break
          const [x, y] = e.m.HEAPF64.slice(at / 8, at / 8 + 2)
          if (!p.FPDFText_GetCharBox(text, i, at, at + 8, at + 16, at + 24)) break
          const [left, right, bottom, top] = e.m.HEAPF64.slice(at / 8, at / 8 + 4)
          chars.push({ code, x, y, bounds: [left, bottom, right, top] })
        }
      } finally {
        p.FPDFText_ClosePage(text)
      }
      if (
        !chars.length ||
        String.fromCharCode(...chars.map((c) => c.code)) !== object.text.replace(/\s/gu, '') ||
        chars.some(
          (c) => !Number.isFinite(c.x) || !Number.isFinite(c.y) || Math.abs(c.y - chars[0].y) > 0.01
        )
      )
        continue
      // Only split at table-sized gaps. A cropped word or an ordinary phrase
      // with normal spaces must retain the original partial-object rejection.
      const groups = []
      for (const char of chars) {
        const last = groups.at(-1)
        if (!last || char.bounds[0] - last.at(-1).bounds[2] > size * 0.9) groups.push([char])
        else last.push(char)
      }
      const cells = groups.map((group) => ({
        left: Math.min(...group.map((char) => char.bounds[0])),
        right: Math.max(...group.map((char) => char.bounds[2]))
      }))
      const tableGap =
        cells.length >= 2 &&
        rectangles.some((r) => {
          if (object.bounds[1] < r.bottom - 2 || object.bounds[3] > r.top + 2) return false
          const contained = cells.filter(
            (cell) => cell.left >= r.x - 2 && cell.right <= r.x + r.width + 2
          )
          return (
            contained.length > 0 &&
            contained.length < cells.length &&
            cells.every(
              (cell) => contained.includes(cell) || cell.right <= r.x || cell.left >= r.x + r.width
            )
          )
        })

      // A PDF.js item can prove a complete label or prose suffix inside a
      // shared object. Match every occurrence, accepting only the one whose
      // complete glyph span is owned by the region; repeated words elsewhere
      // are not ambiguous when their native ink is wholly outside that region.
      const ownedItem = rectangles.some((r) =>
        (r.sourceItems ?? [])
          .flatMap((value, index, items) => [value, items.slice(0, index + 1).join(' ')])
          .some((value) => {
            const literal = value.trim()
            if (
              literal.length < 4 ||
              (!(literal.length >= 8 && /\s/u.test(literal)) && !/[A-Za-z]{3}/u.test(literal))
            )
              return false
            let at = object.text.indexOf(literal)
            while (at >= 0) {
              const start = object.text.slice(0, at).replace(/\s/gu, '').length,
                end = start + literal.replace(/\s/gu, '').length
              if (
                !/[A-Za-z]/u.test(object.text[at - 1] ?? '') &&
                !/[A-Za-z]/u.test(object.text[at + literal.length] ?? '') &&
                chars.every((char, i) =>
                  i >= start && i < end
                    ? char.bounds[0] >= r.x - 0.1 &&
                      char.bounds[2] <= r.x + r.width + 0.1 &&
                      char.bounds[1] >= r.bottom - 2 &&
                      char.bounds[3] <= r.top + 2
                    : char.bounds[2] <= r.x || char.bounds[0] >= r.x + r.width
                )
              )
                return true
              at = object.text.indexOf(literal, at + literal.length)
            }
            return false
          })
      )
      // A numeric citation hit area can exclude a comma serialized with its
      // following digits. Partition only the complete native digit span; the
      // separator must be wholly outside, with every original glyph proven.
      const ownedCitation =
        /^,\d{1,3}\s*$/u.test(object.text) &&
        citations.some(
          (r) =>
            chars[0].code === 44 &&
            chars[0].bounds[2] <= r.x &&
            chars
              .slice(1)
              .every(
                (char) =>
                  char.code >= 48 &&
                  char.code <= 57 &&
                  char.bounds[0] >= r.x - 0.1 &&
                  char.bounds[2] <= r.x + r.width + 0.1 &&
                  char.bounds[1] >= r.bottom &&
                  char.bounds[3] <= r.top
              )
        )
      const ownedClippedRun =
        p.FPDFClipPath_CountPaths(p.FPDFPageObj_GetClipPath(object.obj)) > 0 &&
        rectangles.some(
          (r) =>
            object.bounds[0] >= r.x - 0.1 &&
            object.bounds[2] <= r.x + r.width + 0.1 &&
            object.bounds[1] >= r.bottom - 2 &&
            object.bounds[3] <= r.top + 2
        )
      if (!tableGap && !ownedItem && !ownedClippedRun && !ownedCitation) continue
      // Keep naturally positioned adjacent letters in one native text object.
      // Splitting overlapping antialiased glyph masks can change edge pixels.
      // Try those bounded groups first, retaining the original per-glyph fallback.
      const glyphs = []
      for (const char of chars) {
        const previous = glyphs.at(-1)
        if (
          previous &&
          previous.x === char.x &&
          previous.y === char.y &&
          previous.bounds.every((value, i) => value === char.bounds[i])
        )
          previous.codes.push(char.code)
        else glyphs.push({ ...char, codes: [char.code] })
      }
      const create = (span) => {
        const codes = span.map((char) =>
          char.codes.length === 1
            ? char.code
            : ['ﬀ', 'ﬁ', 'ﬂ', 'ﬃ', 'ﬄ']
                .find((value) => value.normalize('NFKC') === String.fromCharCode(...char.codes))
                ?.charCodeAt(0)
        )
        if (codes.some((code) => !code)) return undefined
        const glyph = p.FPDFPageObj_CreateTextObj(doc, font, size)
        if (!glyph) return undefined
        const buffer = e.alloc((codes.length + 1) * 2)
        let valid = false
        try {
          e.m.HEAPU16.set([...codes, 0], buffer / 2)
          if (!p.FPDFText_SetText(glyph, buffer) || !p.FPDFPageObj_SetFillColor(glyph, ...color))
            return undefined
          p.FPDFPageObj_Transform(glyph, a, 0, 0, d, span[0].x, span[0].y)
          const bounds = [
            Math.min(...span.map((char) => char.bounds[0])),
            Math.min(...span.map((char) => char.bounds[1])),
            Math.max(...span.map((char) => char.bounds[2])),
            Math.max(...span.map((char) => char.bounds[3]))
          ]
          if (
            e.bounds(glyph).some((v, i) => !Number.isFinite(v) || Math.abs(v - bounds[i]) > 0.001)
          )
            return undefined
          valid = true
          return glyph
        } finally {
          e.free(buffer)
          if (!valid) p.FPDFPageObj_Destroy(glyph)
        }
      }
      for (const grouped of [true, false]) {
        const created = [],
          inserted = new Set()
        let verified = 0,
          accepted = false,
          hidden = false
        try {
          for (let i = 0; i < glyphs.length;) {
            let length = 1,
              glyph = create([glyphs[i]])
            if (!glyph) break
            if (grouped)
              for (let end = i + 1; end < Math.min(glyphs.length, i + 16); end++) {
                const span = glyphs.slice(i, end + 1)
                // A combined object must not straddle two independently owned
                // cells or capture unowned prose/operators between their regions.
                if (
                  (ownedCitation && span.some((char) => char.code === 44)) ||
                  !(ownedCitation ? citations : rectangles).some((r) =>
                    span.every(
                      (char) =>
                        char.bounds[0] >= r.x - 0.1 &&
                        char.bounds[2] <= r.x + r.width + 0.1 &&
                        char.bounds[1] >= r.bottom - 2 &&
                        char.bounds[3] <= r.top + 2
                    )
                  )
                )
                  break
                const next = create(span)
                if (!next) break
                p.FPDFPageObj_Destroy(glyph)
                glyph = next
                length = span.length
              }
            created.push(glyph)
            i += length
            verified += length
          }
          if (verified !== glyphs.length) continue
          const before = render(),
            index = e.objects(page).findIndex((o) => o.obj === object.obj)
          if (index < 0) continue
          for (const [offset, glyph] of created.entries()) {
            if (!p.FPDFPage_InsertObjectAtIndex(page, glyph, index + 1 + offset)) break
            inserted.add(glyph)
          }
          if (inserted.size !== created.length || !p.FPDFPageObj_SetIsActive(object.obj, false))
            continue
          hidden = true
          const after = render()
          if (before.some((v, i) => v !== after[i])) continue
          if (!p.FPDFPage_RemoveObject(page, object.obj))
            throw Error('Could not replace shared text run')
          p.FPDFPageObj_Destroy(object.obj)
          accepted = true
          changed = true
        } finally {
          if (!accepted) {
            if (hidden) restored(p.FPDFPageObj_SetIsActive(object.obj, true))
            for (const glyph of created) {
              if (inserted.has(glyph)) restored(p.FPDFPage_RemoveObject(page, glyph))
              p.FPDFPageObj_Destroy(glyph)
            }
          }
        }
        if (accepted) break
      }
    }
    if (changed && !p.FPDFPage_GenerateContent(page)) throw Error('Could not save shared text runs')
  } finally {
    e.free(at)
  }
}

// PDFium omits text from closely overprinted glyph objects (synthetic bold),
// although PDF.js still reports every painted copy. Read only proven duplicates
// in isolation; never remove their ink or normalize the source character count.
export function recoverOverprintedTextSources(e, page, objects) {
  const sources = new Map(),
    groups = [],
    result = { sources, groups }
  if (!objects.some((o) => o.type === 1 && o.text === '')) return result
  const p = e.p,
    at = e.alloc(64),
    states = [],
    metadata = new Map()
  try {
    for (const object of objects.filter((o) => o.type === 1)) {
      if (!p.FPDFPageObj_GetIsActive(object.obj, at)) return result
      const active = !!e.m.HEAP32[at / 4]
      states.push({ object, active })
      if (
        !active ||
        p.FPDFTextObj_GetTextRenderMode(object.obj) !== 0 ||
        p.FPDFPageObj_CountMarks(object.obj) !== 0 ||
        p.FPDFClipPath_CountPaths(p.FPDFPageObj_GetClipPath(object.obj)) > 0 ||
        !p.FPDFPageObj_GetMatrix(object.obj, at)
      )
        continue
      const matrix = [...e.m.HEAPF32.slice(at / 4, at / 4 + 6)]
      if (
        matrix.some((v) => !Number.isFinite(v)) ||
        matrix[0] <= 0 ||
        matrix[1] !== 0 ||
        matrix[2] !== 0 ||
        matrix[3] <= 0 ||
        !p.FPDFTextObj_GetFontSize(object.obj, at)
      )
        continue
      const size = e.m.HEAPF32[at / 4],
        font = p.FPDFTextObj_GetFont(object.obj)
      if (
        !font ||
        size <= 0 ||
        !p.FPDFPageObj_GetFillColor(object.obj, at, at + 4, at + 8, at + 12)
      )
        continue
      const color = [...e.m.HEAPU32.slice(at / 4, at / 4 + 4)]
      if (color[3] !== 255 || object.bounds.some((v) => !Number.isFinite(v))) continue
      metadata.set(object.obj, { matrix, size, font, color })
    }
    const labels = objects.filter(
        (o) =>
          metadata.has(o.obj) &&
          typeof o.text === 'string' &&
          /^[\p{L}\p{N}]{1,16}$/u.test(o.text.trim())
      ),
      candidates = objects
        .filter((o) => o.text === '' && metadata.has(o.obj))
        .map((object) => {
          const meta = metadata.get(object.obj),
            label = labels.find((o) => {
              const other = metadata.get(o.obj),
                tolerance = meta.size * Math.min(meta.matrix[0], meta.matrix[3]) * 0.1
              return (
                meta.font === other.font &&
                meta.size === other.size &&
                meta.matrix.slice(0, 4).every((v, i) => v === other.matrix[i]) &&
                meta.color.every((v, i) => v === other.color[i]) &&
                Math.abs(object.bounds[0] - o.bounds[0]) <= tolerance &&
                Math.abs(object.bounds[1] - o.bounds[1]) <= tolerance &&
                Math.abs(object.bounds[2] - object.bounds[0] - (o.bounds[2] - o.bounds[0])) <
                  0.01 &&
                Math.abs(object.bounds[3] - object.bounds[1] - (o.bounds[3] - o.bounds[1])) < 0.01
              )
            })
          return { object, label }
        })
        .filter((candidate) => candidate.label)
    if (!candidates.length) return result
    const width = Math.ceil(p.FPDF_GetPageWidthF(page) * 2),
      height = Math.ceil(p.FPDF_GetPageHeightF(page) * 2)
    if (width * height > 16 * 1024 ** 2) return result
    const render = () => {
      const bitmap = p.FPDFBitmap_Create(width, height, 1)
      if (!bitmap) throw Error('Could not verify overprinted text sources')
      try {
        p.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)
        p.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0)
        const buffer = p.FPDFBitmap_GetBuffer(bitmap)
        return e.m.HEAPU8.slice(buffer, buffer + height * p.FPDFBitmap_GetStride(bitmap))
      } finally {
        p.FPDFBitmap_Destroy(bitmap)
      }
    }
    const before = render(),
      active = states.filter((state) => state.active),
      requireState = (value, message) => {
        if (!value) throw Error(message)
      }
    try {
      for (const { object } of active)
        if (!p.FPDFPageObj_SetIsActive(object.obj, false))
          throw Error('Could not isolate overprinted text source')
      for (const { object, label } of candidates) {
        if (!p.FPDFPageObj_SetIsActive(object.obj, true))
          throw Error('Could not inspect overprinted text source')
        try {
          const text = p.FPDFText_LoadPage(page)
          if (!text) throw Error('Could not read overprinted text source')
          try {
            const length = p.FPDFTextObj_GetText(object.obj, text, 0, 0)
            if (length <= 2 || length > 66) continue
            const buffer = e.alloc(length)
            try {
              if (p.FPDFTextObj_GetText(object.obj, text, buffer, length) !== length) continue
              const source = Buffer.from(e.m.HEAPU8.slice(buffer, buffer + length))
                .toString('utf16le')
                .replace(/\0$/u, '')
              if (source.trim() === label.text.trim()) sources.set(object.obj, source)
            } finally {
              e.free(buffer)
            }
          } finally {
            p.FPDFText_ClosePage(text)
          }
        } finally {
          requireState(
            p.FPDFPageObj_SetIsActive(object.obj, false),
            'Could not reset overprinted text source'
          )
        }
      }
    } finally {
      let restored = true
      for (const { object } of active) {
        try {
          if (!p.FPDFPageObj_SetIsActive(object.obj, true)) restored = false
        } catch {
          restored = false
        }
      }
      requireState(restored, 'Could not restore overprinted text sources')
    }
    const after = render()
    if (before.some((v, i) => v !== after[i]))
      throw Error('Overprinted text source inspection changed page pixels')
    for (const label of new Set(candidates.map((candidate) => candidate.label))) {
      const copies = candidates.filter((candidate) => candidate.label === label)
      if (copies.some(({ object }) => !sources.has(object.obj))) continue
      const members = new Set([label.obj, ...copies.map(({ object }) => object.obj)]),
        ordered = objects.filter((object) => members.has(object.obj))
      groups.push({
        objects: ordered.map((object) => object.obj),
        labelSource: ordered
          .map((object) => (sources.get(object.obj) ?? object.text).trim())
          .join('')
      })
    }
    return result
  } finally {
    e.free(at)
  }
}
