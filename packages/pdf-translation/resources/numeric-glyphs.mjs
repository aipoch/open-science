/* eslint-disable no-control-regex -- Native control slots are the evidence being verified. */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Worker-only native proof. */
import { PDFArray, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'

// PDF.js interprets C/c followed by decimal digits as a Unicode spelling when
// ToUnicode is absent. That spelling does not establish what the glyph means.
// Prove it only for preservation, from the exact embedded font and encoding.
// Admit a partial ToUnicode only when every single-byte source token is above
// the requested code. This covers publisher maps whose declared code space
// starts after their symbolic slots, without interpreting or repairing CMaps.
const decoded = (stream) => {
  try {
    return Buffer.from(decodePDFRawStream(stream).decode())
  } catch {
    // An unsupported or corrupt optional stream cannot establish font identity.
    return undefined
  }
}

const beforeUnicodeMap = (font, code) => {
  if (!font.has(PDFName.of('ToUnicode'))) return true
  const stream = font.lookup(PDFName.of('ToUnicode'))
  if (!(stream instanceof PDFRawStream) || stream.dict.has(PDFName.of('UseCMap'))) return false
  const bytes = decoded(stream)
  if (!bytes) return false
  const text = bytes.toString('latin1').replace(/%[^\r\n]*/gu, '')
  if (/usecmap|begin(?:cidchar|cidrange|notdefchar|notdefrange)/iu.test(text)) return false
  const space =
    /\b1\s+begincodespacerange\s*<([\da-f]{2})>\s*<([\da-f]{2})>\s*endcodespacerange/iu.exec(text)
  if (
    !space ||
    (text.match(/begincodespacerange/gu)?.length ?? 0) !== 1 ||
    code >= parseInt(space[1], 16) ||
    parseInt(space[1], 16) > parseInt(space[2], 16)
  )
    return false
  const blocks = [...text.matchAll(/\b(\d+)\s+beginbf(char|range)\s*([\s\S]*?)endbf\2/gu)]
  if (!blocks.length || blocks.length !== (text.match(/beginbf(?:char|range)/gu)?.length ?? 0))
    return false
  for (const [, count, kind, content] of blocks) {
    const pattern =
      kind === 'char'
        ? /<([\da-f]{2})>\s*<[\da-f]{4}>/giu
        : /<([\da-f]{2})>\s*<([\da-f]{2})>\s*<[\da-f]{4}>/giu
    const entries = [...content.matchAll(pattern)]
    if (
      entries.length !== Number(count) ||
      content.replace(pattern, '').trim() ||
      entries.some(
        (entry) =>
          parseInt(entry[1], 16) <= code ||
          (kind === 'range' && parseInt(entry[2], 16) < parseInt(entry[1], 16))
      )
    )
      return false
  }
  return true
}

export function proveNumericGlyphSources(e, page, resources, objects) {
  const candidates = objects.filter(
    (o) => o.type === 1 && /^[\x01-\x08\x0e-\x1f]{1,512}$/u.test(o.text.trim())
  )
  const sources = new Map()
  if (!candidates.length) return sources
  const fonts = new Set(),
    visited = new Set()
  let inventoryIncomplete = false
  const visit = (resource) => {
    if (!(resource instanceof PDFDict) || visited.has(resource)) return
    if (visited.size >= 128) {
      inventoryIncomplete = true
      return
    }
    visited.add(resource)
    const dictionary = resource.lookup(PDFName.of('Font'))
    if (dictionary instanceof PDFDict)
      for (const [key] of dictionary.entries()) {
        const font = dictionary.lookup(key)
        if (font instanceof PDFDict) fonts.add(font)
      }
    const forms = resource.lookup(PDFName.of('XObject'))
    if (forms instanceof PDFDict)
      for (const [key] of forms.entries()) {
        const form = forms.lookup(key)
        if (
          form instanceof PDFRawStream &&
          form.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')
        )
          visit(form.dict.lookup(PDFName.of('Resources')))
      }
  }
  visit(resources)
  if (inventoryIncomplete) return sources
  const { p, m } = e,
    at = e.alloc(4),
    nativeFonts = new Map()
  const fontProof = (handle) => {
    if (nativeFonts.has(handle)) return nativeFonts.get(handle)
    nativeFonts.set(handle, undefined)
    if (!p.FPDFFont_GetFontData(handle, 0, 0, at)) return
    const length = m.HEAPU32[at / 4]
    if (!length || length > 16 * 1024 ** 2) return
    const buffer = e.alloc(length)
    let data
    try {
      if (!p.FPDFFont_GetFontData(handle, buffer, length, at) || m.HEAPU32[at / 4] !== length)
        return
      data = Buffer.from(m.HEAPU8.slice(buffer, buffer + length))
    } finally {
      e.free(buffer)
    }
    // Same font bytes with different resource encodings are ambiguous: PDFium's
    // font handle alone does not identify which PDF dictionary supplied the run.
    const matches = []
    for (const font of fonts) {
      if (font.get(PDFName.of('Subtype')) !== PDFName.of('Type1')) continue
      const descriptor = font.lookup(PDFName.of('FontDescriptor'))
      const file = descriptor instanceof PDFDict && descriptor.lookup(PDFName.of('FontFile3'))
      if (
        !(file instanceof PDFRawStream) ||
        file.dict.get(PDFName.of('Subtype')) !== PDFName.of('Type1C')
      )
        continue
      const bytes = decoded(file)
      if (!bytes) return
      if (data.equals(bytes)) matches.push(font)
    }
    if (matches.length !== 1) return
    const encoding = matches[0].lookup(PDFName.of('Encoding'))
    const differences = encoding instanceof PDFDict && encoding.lookup(PDFName.of('Differences'))
    if (!(differences instanceof PDFArray)) return
    const aliases = new Map()
    let code
    for (const value of differences.asArray()) {
      if (!(value instanceof PDFName)) {
        code = value.asNumber?.()
        if (!Number.isInteger(code) || code < 0 || code > 255) return
        continue
      }
      if (!Number.isInteger(code) || code > 255 || aliases.has(code)) return
      const name = value.decodeText()
      // Hexadecimal-looking C names make PDF.js reinterpret every numeric C
      // name as hexadecimal; do not guess at that ambiguous encoding.
      if (
        /^[Cc]/u.test(name) &&
        name.length >= 3 &&
        name.length <= 4 &&
        !/^[Cc]\d{2,3}$/u.test(name)
      )
        return
      aliases.set(
        code,
        /^[Cc]\d{2,3}$/u.test(name) && beforeUnicodeMap(matches[0], code)
          ? Number(name.slice(1))
          : undefined
      )
      code++
    }
    nativeFonts.set(handle, aliases)
    return aliases
  }
  const text = p.FPDFText_LoadPage(page)
  try {
    if (!text) return sources
    const count = p.FPDFText_CountChars(text)
    if (count < 0 || count > 100000) return sources
    const characters = new Map(candidates.map((o) => [o.obj, []]))
    for (let index = 0; index < count; index++) {
      const owned = characters.get(p.FPDFText_GetTextObject(text, index))
      if (owned && !/\s/u.test(String.fromCodePoint(p.FPDFText_GetUnicode(text, index))))
        owned.push(index)
    }
    for (const object of candidates) {
      const indices = characters.get(object.obj)
      if (
        indices.length !== [...object.text.trim()].length ||
        !object.bounds.every(Number.isFinite) ||
        object.bounds[2] <= object.bounds[0] ||
        object.bounds[3] <= object.bounds[1]
      )
        continue
      const aliases = fontProof(p.FPDFTextObj_GetFont(object.obj))
      if (!aliases) continue
      const codes = [...object.text.trim()].map((char) => char.codePointAt(0))
      if (
        indices.some(
          (index, offset) =>
            p.FPDFText_GetUnicode(text, index) !== codes[offset] ||
            p.FPDFText_HasUnicodeMapError(text, index) !== 1 ||
            p.FPDFText_IsHyphen(text, index) !== 0 ||
            p.FPDFText_IsGenerated(text, index) !== 0
        )
      )
        continue
      if (
        codes.some(
          (code) => !aliases.get(code) || /\s/u.test(String.fromCodePoint(aliases.get(code)))
        )
      )
        continue
      sources.set(
        object.obj,
        object.text.replace(/[\x01-\x08\x0e-\x1f]/gu, (char) =>
          String.fromCodePoint(aliases.get(char.codePointAt(0)))
        )
      )
    }
  } finally {
    if (text) p.FPDFText_ClosePage(text)
    e.free(at)
  }
  return sources
}
