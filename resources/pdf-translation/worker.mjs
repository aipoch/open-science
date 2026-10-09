import {
  nativeMathSymbolText,
  nativeMathAlphabet,
  nativeTransposeSourceIndices
} from './math-symbols.mjs'
import { pdfTranslationLineEnds } from './line-breaks.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker JavaScript. */
import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import * as fontkit from 'fontkit'
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFObjectCopier,
  PDFRef,
  PDFArray,
  PDFStream,
  decodePDFRawStream
} from 'pdf-lib'
import { engine } from './pdfium.mjs'
import { nativeReadingOrder } from './reading-order.mjs'
import { unwrapPageContainers } from './page-containers.mjs'
import { translateFormLabels } from './form-labels.mjs'
import { splitSharedTextRuns, recoverOverprintedTextSources } from './shared-text-runs.mjs'
import {
  pdfLinkLabelKey,
  pdfLinkAddressMatches,
  translatedPdfLinkLabel,
  translatedPdfLinkFragment,
  translatedPdfBracketedReference
} from './link-labels.mjs'
import { resolveNativeMathAccents, resolveNativeLatinAccents } from './math-accents.mjs'
import { resolveInlineFractions } from './math-fractions.mjs'
import {
  resolveScientificScriptSpans,
  resolveNestedScriptGroups,
  resolveExplicitTransposeIndices,
  resolveExplicitPowerIndices,
  resolveOrdinalSuffixIndices
} from './scientific-scripts.mjs'

// Structured worker diagnostics contain only fixed reason codes, locations and measurements.
const retainedUnits = new Map()
const retainedUnitObjects = new WeakMap()
const timings = { generationMs: 0, pdfiumSaveMs: 0, formLabelsMs: 0, mergeMs: 0, mergeSaveMs: 0 }
const diagnoseRetention = (unit, code, phase) => {
  if (!retainedUnitObjects.has(unit)) retainedUnitObjects.set(unit, { code, phase })
  const unitIndex = workerData.units.indexOf(unit)
  if (unitIndex < 0 || retainedUnits.has(unitIndex)) return
  retainedUnits.set(unitIndex, {
    unitIndex,
    code,
    phase,
    pageNumbers: [...new Set(unit.fragments.map((fragment) => fragment.pageNumber))],
    fragmentCount: unit.fragments.length
  })
}
const diagnostics = () => ({
  ...timings,
  retainedCount: retainedUnits.size,
  retained: [...retainedUnits.values()].slice(0, 20),
  workerHeapUsedBytes: process.memoryUsage().heapUsed,
  workerExternalBytes: process.memoryUsage().external
})
let pageNumber
const check = (value, code = 'unsupported-layout') => {
  if (!value)
    throw Object.assign(new Error('PDF generation rejected'), {
      failure: { code, ...(pageNumber ? { pageNumber } : {}) }
    })
}
const normalized = (text) => [...text.normalize('NFKC')].filter((char) => !/\s/u.test(char))
// Localized colons/parentheses do not require repainting an otherwise identical
// scientific label. Keep all other glyphs and internal word/number spacing exact:
// NFKC would also fold meaningful mathematical letters and superscripts.
const presentationText = (text) =>
  text
    .replace(/[：（）]/gu, (char) => ({ '：': ':', '（': '(', '）': ')' })[char])
    .replace(/[ \t]*([:()])[ \t]*/gu, '$1')
// A signed numeric value may use ASCII or mathematical minus. Keep the
// original character for the separate, engine-proven line-end hyphen rule.
const sameSourceCharacter = (expected, actual, next) =>
  expected === actual ||
  (/^[−-]$/u.test(expected ?? '') && /^[−-]$/u.test(actual) && /^\d$/u.test(next ?? ''))
const sourceMatches = (expected, actual, verifiedHyphens = false) => {
  const left = normalized(expected),
    right = normalized(actual)
  let index = 0
  for (const char of right) {
    if (sameSourceCharacter(left[index], char, left[index + 1])) index++
    else if (verifiedHyphens && char === '\u0002') {
      // PDFium's hyphen marker may correspond to a retained or joined line break.
      // It must never stand in for an arbitrary letter, number or scientific symbol.
      if (left[index] === '-' || left[index] === '\u00ad') index++
    } else return false
  }
  return index === left.length
}
// Resolve repeated numeric references/subscripts by the complete token (1–4,
// 5,6, A0), then its occurrence. A bare digit search can select an unrelated
// measurement or the same reference in an earlier sentence.
const inlineTargetOffset = (source, translation, label, offset, identifier = false) => {
  // An approximation may become prose ("about") while a numeric range keeps
  // the same tilde. Match its complete, unique range before counting bare signs.
  if (label === '∼') {
    const ranges = (text) => [
      ...text.matchAll(/(?<![\d.])\d+(?:\.\d+)?%?\s*∼\s*\d+(?:\.\d+)?%?(?!\d|\.\d)/gu)
    ]
    const range = ranges(source).find((match) => match.index + match[0].indexOf(label) === offset)
    if (range) {
      const same = (match) => match[0].replace(/\s/gu, '') === range[0].replace(/\s/gu, '')
      const from = ranges(source).filter(same),
        to = ranges(translation).filter(same)
      if (from.length === 1 && to.length === 1) return to[0].index + to[0][0].indexOf(label)
    }
  }
  // A separately painted sign/digit belongs to the complete signed unit power.
  // Publisher thin spaces may disappear in translation. Match that unit and its
  // power together, so kg−1, min −1 and h−1 never borrow each other's marker.
  if (/^(?:[−+-]|\d{1,3})$/u.test(label)) {
    const powers = (text) => [
      ...text.matchAll(
        /(?<![A-Za-z\p{Script=Greek}])([A-Za-z\p{Script=Greek}]{1,4})\s*([−+-]\s*\d+)(?!\d)/gu
      )
    ]
    const power = powers(source).find((match) => {
      const start = match.index + match[0].length - match[2].length
      return offset >= start && offset + label.length <= match.index + match[0].length
    })
    if (power) {
      const key = (match) => match[0].replace(/\s/gu, ''),
        from = powers(source).filter((match) => key(match) === key(power)),
        to = powers(translation).filter((match) => key(match) === key(power)),
        index = from.findIndex((match) => match.index === power.index)
      if (from.length === to.length) {
        const target = to[index],
          prefix = source.slice(power.index, offset).replace(/\s/gu, '')
        let cursor = target.index,
          length = 0
        while (cursor < target.index + target[0].length && length < prefix.length) {
          if (!/\s/u.test(translation[cursor])) length++
          cursor++
        }
        while (/\s/u.test(translation[cursor] ?? '')) cursor++
        if (translation.slice(cursor, cursor + label.length) === label) return cursor
      }
      return -1
    }
  }
  // Repeated years belong to complete, closed author citations.
  if (/^(?:19|20)\d{2}[a-z]$/u.test(label))
    return translatedPdfLinkFragment(source, translation, label, offset)?.start ?? -1
  const tokens = (text) => [
    ...text.matchAll(
      /^[*∗†‡#]+$/u.test(label)
        ? /[*∗†‡#]+/gu
        : identifier
          ? /[A-Za-z\p{Script=Greek}]*\d+(?:[,.–−-]\d+)*/gu
          : /\d+(?:[,.–−-]\d+)*/gu
    )
  ]
  // A citation object can include a trailing comma or full stop. Match its
  // complete numeric token, not an unrelated year containing the same digits.
  const numericLength = /^\d/u.test(label) ? label.replace(/[.,;:]+$/u, '').length : label.length
  const token = tokens(source).find(
    (match) => match.index <= offset && match.index + match[0].length >= offset + numericLength
  )
  if (token) {
    const from = tokens(source).filter((match) => match[0] === token[0]),
      to = tokens(translation).filter((match) => match[0] === token[0]),
      occurrence = from.findIndex((match) => match.index === token.index)
    if (from.length === to.length && occurrence >= 0)
      return to[occurrence].index + offset - token.index
  }
  const bracketed = /^\[\d+(?:[,–-]\d+)*\]$/u.test(label)
  if (bracketed || /^[A-Za-z][A-Za-z .&-]*$/u.test(label)) {
    const occurrences = (text) => {
      const result = []
      for (
        let index = text.indexOf(label);
        index >= 0;
        index = text.indexOf(label, index + label.length)
      ) {
        if (
          bracketed ||
          (!/[A-Za-z]/u.test(text[index - 1] ?? '') &&
            !/[A-Za-z]/u.test(text[index + label.length] ?? ''))
        )
          result.push(index)
      }
      return result
    }
    const from = occurrences(source),
      to = occurrences(translation),
      occurrence = from.indexOf(offset)
    if (occurrence >= 0 && from.length === to.length) return to[occurrence]
  }
  const target = translation.indexOf(label)
  return source.indexOf(label) === offset &&
    source.lastIndexOf(label) === offset &&
    target >= 0 &&
    translation.lastIndexOf(label) === target
    ? target
    : -1
}
const sourceGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const objectSourceOffsets = (
  source,
  objects,
  verifiedHyphens,
  partial = false,
  allowStandaloneMath = false,
  allowRegionEndHyphen = false
) => {
  const expected = []
  for (const { segment, index } of sourceGraphemes.segment(source)) {
    for (const value of normalized(segment)) expected.push({ value, index })
  }
  const offsets = new Map(),
    extraOffsets = new Map(),
    typographicHyphens = new Set()
  let cursor = 0,
    trimmedEndHyphen = false
  for (const object of objects) {
    const characters = normalized(object.text)
    for (const [characterIndex, char] of characters.entries()) {
      if (sameSourceCharacter(expected[cursor]?.value, char, expected[cursor + 1]?.value)) {
        if (!offsets.has(object.i)) offsets.set(object.i, expected[cursor].index)
        cursor++
      } else if (
        expected[cursor]?.value === '-' &&
        char === '‐' &&
        object.asciiHyphenProven &&
        characters.length === 1
      ) {
        offsets.set(object.i, expected[cursor].index)
        typographicHyphens.add(object.i)
        cursor++
      } else if (
        allowStandaloneMath &&
        /^[√∛∜∫∑∏]$/u.test(char) &&
        expected[cursor]?.value !== char
      ) {
        // PDF.js can extract an inline radical or summation as a separate
        // source-only unit. Keep the native glyph in place while matching the
        // surrounding prose against its saved source.
        extraOffsets.set(object.i, expected[cursor]?.index ?? source.length)
      } else if (verifiedHyphens && char === '\u0002') {
        if (['-', '\u00ad'].includes(expected[cursor]?.value)) cursor++
      } else if (
        allowRegionEndHyphen &&
        char === '-' &&
        object === objects.at(-1) &&
        characterIndex === characters.length - 1 &&
        /^[a-z]$/u.test(expected[cursor]?.value ?? '') &&
        /^[a-z]{3}$/iu.test(
          expected
            .slice(Math.max(0, cursor - 3), cursor)
            .map((part) => part.value)
            .join('')
        )
      ) {
        // A word split across columns/pages may keep a literal final hyphen:
        // PDFium only marks within-column line breaks. All preceding characters
        // already matched; the following region must prove the remaining suffix.
        trimmedEndHyphen = true
      } else return { offsets: new Map(), extraOffsets: new Map(), endOffset: 0 }
    }
  }
  return partial || cursor === expected.length
    ? {
        offsets,
        extraOffsets,
        typographicHyphens,
        endOffset: expected[cursor]?.index ?? source.length,
        trimmedEndHyphen
      }
    : { offsets: new Map(), extraOffsets: new Map(), endOffset: 0 }
}
// PDF.js rectangles use text advances; PDFium bounds include glyph outlines.
// Keep this small, fixed tolerance in both ownership passes so final glyphs do not
// fall outside the extraction box while normalized source equality still rejects
// unrelated objects that happen to enter the boundary.
const objectTolerance = 2
// Opposite corners suffice for axis-aligned rectangles under quarter turns.
const boundsBetween = ([x1, y1], [x2, y2]) => ({
  x: Math.min(x1, x2),
  bottom: Math.min(y1, y2),
  top: Math.max(y1, y2),
  width: Math.abs(x2 - x1),
  height: Math.abs(y2 - y1)
})

const regionsOverlap = (
  first,
  second,
  sameUnit = first.unit !== undefined && first.unit === second.unit
) => {
  const overlaps = (a, b) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.bottom < b.top && a.top > b.bottom
  // Ink proof may remove an empty-margin collision, never enlarge an existing
  // region. Source object overhangs keep their independent native preflight.
  return (
    first.fragment.pageNumber === second.fragment.pageNumber &&
    overlaps(first.rect, second.rect) &&
    overlaps(first.collisionRect ?? first.rect, second.collisionRect ?? second.rect) &&
    (!sameUnit ||
      (first.collisionBoxes ?? [first.collisionRect ?? first.rect]).some((a) =>
        (second.collisionBoxes ?? [second.collisionRect ?? second.rect]).some((b) => overlaps(a, b))
      ))
  )
}

// This worker owns all engine/font memory and has no filesystem input supplied by the renderer.
// Terminating it cancels WASM work as well as JavaScript; only the bundled font is read from disk.
async function generate({ data, units, pages, preserveUnsupported = false, selectedPages }) {
  const fontBytes = await readFile(new URL('./NotoSansSC-Regular.otf', import.meta.url))
  const face = fontkit.create(fontBytes)
  // Greek compatibility variants may use an available outline, but must keep
  // their requested Unicode identity in the PDF's ToUnicode map.
  const greekGlyph = (char) => {
    if (!/^[\p{Script=Greek}]$/u.test(char) || face.hasGlyphForCodePoint(char.codePointAt(0)))
      return char
    const value = char.normalize('NFKC')
    return [...value].length === 1 && face.hasGlyphForCodePoint(value.codePointAt(0)) ? value : char
  }
  const shapeGreek = (text) => [...text].map(greekGlyph).join('')
  const normalizeOutputGlyphs = (text, source) =>
    [...text]
      .map((char) => {
        if (face.hasGlyphForCodePoint(char.codePointAt(0)) || greekGlyph(char) !== char) return char
        // A superscript sign/digit needs its native raised glyph. Folding it before
        // anchor matching would silently turn a power into a body-line number.
        if (/^[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]$/u.test(char)) return char
        // A source mathematical alphabet must reach native anchor matching
        // unchanged; folding it here erases its original script/font identity.
        if (/^[\u{1D400}-\u{1D7CB}]$/u.test(char) && source.includes(char)) return char
        const normalized = char.normalize('NFKC')
        return [...normalized].every((value) => face.hasGlyphForCodePoint(value.codePointAt(0)))
          ? normalized
          : char
      })
      .join('')
  const carrier = await PDFDocument.create()
  let creatingFont = 0
  carrier.registerFontkit({
    create(bytes) {
      const index = creatingFont++
      const font = fontkit.create(bytes),
        subset = font.createSubset.bind(font),
        layout = font.layout.bind(font)
      font.layout = (text, features) => {
        const run = layout(shapeGreek(text), features)
        run.glyphs = run.glyphs.map((glyph) => {
          const char = glyphAliases.get(glyph.id)?.[index]
          return char && greekGlyph(char) !== char
            ? Object.assign(Object.create(glyph), { codePoints: [char.codePointAt(0)] })
            : glyph
        })
        return run
      }
      font.createSubset = () => {
        const value = subset()
        value.encodeStream = () => Readable.from([value.encode()])
        return value
      }
      return font
    }
  })
  // Different Unicode characters can share an outline (for example • and ·).
  // A subset CID has only one ToUnicode value, so put each alias in a separate
  // subset. The same alias rank can share a font across unrelated glyph IDs.
  const glyphAliases = new Map(),
    fontForCharacter = new Map()
  for (const unit of units)
    for (const char of unit.translation) {
      if (fontForCharacter.has(char)) continue
      const glyph = face.glyphForCodePoint(greekGlyph(char).codePointAt(0))
      if (!glyph.id) {
        fontForCharacter.set(char, 0)
        continue
      }
      const aliases = glyphAliases.get(glyph.id) ?? []
      fontForCharacter.set(char, aliases.length)
      aliases.push(char)
      glyphAliases.set(glyph.id, aliases)
    }
  const fonts = [],
    carrierPage = carrier.addPage([612, 792])
  const fontCount = Math.max(1, ...[...glyphAliases.values()].map((aliases) => aliases.length))
  for (let index = 0; index < fontCount; index++) {
    const font = await carrier.embedFont(fontBytes, {
      subset: true,
      features: { liga: false, kern: false }
    })
    fonts.push(font)
    // Exactly one carrier object per font makes the imported handle order explicit.
    const seed = [...fontForCharacter].find(([, assigned]) => assigned === index)?.[0] ?? 'X'
    carrierPage.drawText(seed, { font, size: 12, x: 0, y: 0 })
  }
  const e = await engine(),
    { p } = e
  let input = e.open(data)
  check(p.FPDF_GetPageCount(input.doc) === pages.length)
  check(p.FPDF_GetSignatureCount(input.doc) === 0)
  const metadata = await PDFDocument.load(data, { updateMetadata: false }),
    nativePages = metadata.getPages(),
    sharedStates = new Map()
  for (const page of nativePages) {
    const states = page.node.Resources()?.lookup(PDFName.of('ExtGState'))
    if (states instanceof PDFDict) sharedStates.set(states, (sharedStates.get(states) ?? 0) + 1)
  }
  let detachedStates = false
  for (const [index, page] of nativePages.entries()) {
    // Match page-container preprocessing, which can also regenerate unwrapped pages.
    if (selectedPages && !selectedPages.has(index + 1)) continue
    const resources = page.node.Resources(),
      states = resources?.lookup(PDFName.of('ExtGState'))
    if (!(states instanceof PDFDict) || sharedStates.get(states) < 2) continue
    // PDFium replaces a page's graphics-state dictionary during generation.
    // A shared dictionary would strand other pages' generated /FXE names.
    const local = resources.clone(metadata.context)
    local.set(PDFName.of('ExtGState'), metadata.context.register(states.clone(metadata.context)))
    page.node.set(PDFName.of('Resources'), metadata.context.register(local))
    detachedStates = true
  }
  if (detachedStates) {
    const detached = await metadata.save()
    input.close()
    input = e.open(detached)
  }
  await unwrapPageContainers(e, input.doc, data, pages.length, selectedPages)
  // InDesign exports citation links with an empty appearance ("q Q"). It has
  // no paint to relocate; keep the stream and action intact when moving the rect.
  // Inspect every appearance mode, rejecting state dictionaries and unknown paint.
  const emptyLinkAppearances = metadata.getPages().map((page) => {
    const annotations = page.node.Annots()
    return (annotations?.asArray() ?? [])
      .map((ref) => metadata.context.lookup(ref))
      .filter(
        (annot) =>
          annot instanceof PDFDict && annot.get(PDFName.of('Subtype'))?.toString() === '/Link'
      )
      .map((annot) => {
        const appearance = annot.lookup(PDFName.of('AP'))
        if (!(appearance instanceof PDFDict) || !appearance.entries().length) return false
        return appearance.entries().every(([mode, ref]) => {
          const stream = metadata.context.lookup(ref)
          if (!['/N', '/R', '/D'].includes(mode.toString()) || !(stream instanceof PDFRawStream))
            return false
          try {
            return /^(?:[\t\n\f\r ]*|[\t\n\f\r ]*q[\t\n\f\r ]+Q[\t\n\f\r ]*)$/u.test(
              Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')
            )
          } catch {
            return false
          }
        })
      })
  })
  let annotationsRemoved = false
  const links = (page, pageIndex) => {
    // PDFium/PDF.js annotation types 1–16 are notes and visual markup (except Link=2).
    // Remove them only from this generated copy: their coordinates refer to the original text.
    // Do this before recording link indices, since removing annotations shifts those indices.
    for (let i = p.FPDFPage_GetAnnotCount(page) - 1; i >= 0; i--) {
      const annot = p.FPDFPage_GetAnnot(page, i)
      check(annot, 'annotations')
      const type = p.FPDFAnnot_GetSubtype(annot)
      p.FPDFPage_CloseAnnot(annot)
      if (type === 2) continue
      check(type >= 1 && type <= 16, 'annotations')
      check(p.FPDFPage_RemoveAnnot(page, i), 'annotations')
      annotationsRemoved = true
    }
    const result = [],
      count = p.FPDFPage_GetAnnotCount(page)
    check(count >= 0, 'annotations')
    for (let i = 0; i < count; i++) {
      const annot = p.FPDFPage_GetAnnot(page, i),
        at = e.alloc(32)
      try {
        check(annot && p.FPDFAnnot_GetSubtype(annot) === 2, 'annotations')
        check(!p.FPDFAnnot_HasKey(annot, 'AA'), 'annotations')
        const link = p.FPDFAnnot_GetLink(annot),
          action = p.FPDFLink_GetAction(link)
        // Some publishers retain inert Link annotations with neither an action nor
        // a destination. They are safe to carry forward unchanged. A direct
        // destination, when present, is still checked against the page count.
        const kind = action ? p.FPDFAction_GetType(action) : 0
        check(kind === 0 || kind === 1 || kind === 3, 'annotations')
        if (kind === 0 || kind === 1) {
          const dest = p.FPDFLink_GetDest(input.doc, link),
            index = dest ? p.FPDFDest_GetDestPageIndex(input.doc, dest) : -1
          // A page extracted from a larger PDF may retain named destinations to
          // pages outside this generated subset. Keep those links unchanged when
          // preservation is enabled instead of rejecting the whole document.
          check(!dest || (index >= 0 && index < pages.length) || preserveUnsupported, 'annotations')
        }
        check(p.FPDFAnnot_GetRect(annot, at), 'annotations')
        const coordinates = e.m.HEAPF32.slice(at / 4, at / 4 + 4)
        check(coordinates.every(Number.isFinite), 'annotations')
        // PDF rectangles specify opposite corners in either order. Match PDF.js normalization.
        const left = Math.min(coordinates[0], coordinates[2]),
          right = Math.max(coordinates[0], coordinates[2]),
          top = Math.max(coordinates[1], coordinates[3]),
          bottom = Math.min(coordinates[1], coordinates[3])
        const quads = p.FPDFAnnot_CountAttachmentPoints(annot)
        for (let q = 0; q < quads; q++) {
          check(p.FPDFAnnot_GetAttachmentPoints(annot, q, at), 'annotations')
          const points = e.m.HEAPF32.slice(at / 4, at / 4 + 8)
          check(
            points.every(
              (v, n) =>
                Number.isFinite(v) && (n % 2 ? v >= bottom && v <= top : v >= left && v <= right)
            ),
            'annotations'
          )
        }
        let uri
        if (kind === 3) {
          const length = p.FPDFAction_GetURIPath(input.doc, action, 0, 0)
          check(length > 0 && length <= 65536, 'annotations')
          const pointer = e.alloc(length)
          try {
            check(
              p.FPDFAction_GetURIPath(input.doc, action, pointer, length) === length,
              'annotations'
            )
            uri = Buffer.from(e.m.HEAPU8.slice(pointer, pointer + length - 1)).toString('utf8')
          } finally {
            e.free(pointer)
          }
        }
        result.push({
          index: i,
          uri,
          left,
          top,
          right,
          bottom,
          wholeRegion:
            !quads && (!p.FPDFAnnot_HasKey(annot, 'AP') || emptyLinkAppearances[pageIndex][i])
        })
      } finally {
        e.free(at)
        if (annot) p.FPDFPage_CloseAnnot(annot)
      }
    }
    return result
  }
  const verifiedHyphens = (page) => {
    const text = p.FPDFText_LoadPage(page)
    check(text, 'source-mismatch')
    const at = e.alloc(32),
      unknown = []
    try {
      const count = p.FPDFText_CountChars(text)
      check(count >= 0, 'source-mismatch')
      for (let i = 0; i < count; i++) {
        if (p.FPDFText_GetUnicode(text, i) !== 2 || p.FPDFText_IsHyphen(text, i) === 1) continue
        // An unlocatable marker keeps the conservative page-wide veto.
        if (!p.FPDFText_GetCharBox(text, i, at, at + 8, at + 16, at + 24)) return () => false
        const [left, right, bottom, top] = e.m.HEAPF64.slice(at / 8, at / 8 + 4)
        if (![left, right, bottom, top].every(Number.isFinite) || right < left || top < bottom)
          return () => false
        unknown.push({ left, right, bottom, top })
      }
      // The same tolerance covers glyphs admitted by object ownership. An unknown
      // glyph elsewhere on the page must not disable verified line-end hyphens.
      return (rect) =>
        unknown.every(
          (box) =>
            box.left > rect.x + rect.width + objectTolerance ||
            box.right < rect.x - objectTolerance ||
            box.bottom > rect.top + objectTolerance ||
            box.top < rect.bottom - objectTolerance
        )
    } finally {
      e.free(at)
      p.FPDFText_ClosePage(text)
    }
  }
  // PDF.js fragments are relative to the visible MediaBox/CropBox intersection.
  // Keep object matching and replacement in absolute PDF user coordinates.
  const geometry = pages.map((expected, index) => {
    if (selectedPages && !selectedPages.has(index + 1)) return undefined
    pageNumber = index + 1
    const page = p.FPDF_LoadPage(input.doc, index)
    check(page)
    const box = e.alloc(16)
    try {
      const rotation = p.FPDFPage_GetRotation(page)
      check([0, 1, 2, 3].includes(rotation))
      const pageLinks = links(page, index)
      check(p.FPDF_GetPageBoundingBox(page, box))
      const [left, top, right, bottom] = e.m.HEAPF32.slice(box / 4, box / 4 + 4)
      check(
        [left, top, right, bottom].every(Number.isFinite) &&
          Math.abs((rotation % 2 ? top - bottom : right - left) - expected.width) < 0.001 &&
          Math.abs((rotation % 2 ? right - left : top - bottom) - expected.height) < 0.001 &&
          Math.abs(p.FPDF_GetPageWidthF(page) - expected.width) < 0.001 &&
          Math.abs(p.FPDF_GetPageHeightF(page) - expected.height) < 0.001
      )
      return {
        links: pageLinks,
        verifiedHyphens: verifiedHyphens(page),
        toPdf(x, y) {
          switch (rotation) {
            case 1:
              return [left + y, bottom + x]
            case 2:
              return [right - x, bottom + y]
            case 3:
              return [right - y, top - x]
            default:
              return [left + x, top - y]
          }
        }
      }
    } finally {
      e.free(box)
      p.FPDF_ClosePage(page)
    }
  })
  // PDFium's Form bounds include drawing outside the Form's mandatory BBox.
  // Inspect the actual clipped paint before rejecting neighboring prose. Keep
  // images/Forms untouched, and restore all object activity even on failure.
  let graphicMask
  const overlapsGraphic = (page, objects, fragment, rect, preserved = [], sourceInk) => {
    const maskKey = fragment.pageNumber + ':' + preserved.join(',')
    if (
      !objects.some(
        (o) =>
          !preserved.includes(o.i) &&
          (o.type === 3 || o.type === 5) &&
          o.bounds[0] < rect.x + rect.width &&
          o.bounds[2] > rect.x &&
          o.bounds[1] < rect.top &&
          o.bounds[3] > rect.bottom
      )
    )
      return false
    if (graphicMask?.key !== maskKey) {
      const size = pages[fragment.pageNumber - 1],
        width = Math.ceil(size.width * 2),
        height = Math.ceil(size.height * 2)
      check(width * height <= 16 * 1024 ** 2)
      const bitmap = p.FPDFBitmap_Create(width, height, 1),
        at = e.alloc(4),
        states = []
      check(bitmap)
      try {
        check(p.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0))
        for (const object of objects) {
          check(p.FPDFPageObj_GetIsActive(object.obj, at))
          const active = !!e.m.HEAP32[at / 4]
          states.push([object.obj, active])
          if (preserved.includes(object.i) || (object.type !== 3 && object.type !== 5))
            check(p.FPDFPageObj_SetIsActive(object.obj, false))
        }
        p.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0)
        const buffer = p.FPDFBitmap_GetBuffer(bitmap),
          stride = p.FPDFBitmap_GetStride(bitmap),
          alpha = new Uint8Array(width * height),
          colors = new Uint32Array(width * height)
        check(buffer && stride >= width * 4)
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            alpha[y * width + x] = e.m.HEAPU8[buffer + y * stride + x * 4 + 3]
        // Check the visible backdrop separately. A solid vector fill can
        // cover a raster drop shadow, without making unrelated paths into
        // new image obstacles elsewhere on the page.
        for (const [index, [object, active]] of states.entries()) {
          const record = objects[index]
          check(
            p.FPDFPageObj_SetIsActive(
              object,
              active && record.type !== 1 && !preserved.includes(record.i)
            )
          )
        }
        check(p.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0))
        p.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0)
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            colors[y * width + x] = e.m.HEAPU32[(buffer + y * stride) / 4 + x]
        graphicMask = { key: maskKey, width, height, alpha, colors }
      } finally {
        for (const [object, active] of states) check(p.FPDFPageObj_SetIsActive(object, active))
        p.FPDFBitmap_Destroy(bitmap)
        e.free(at)
      }
    }
    const { width, height, alpha, colors } = graphicMask,
      size = pages[fragment.pageNumber - 1],
      origin = geometry[fragment.pageNumber - 1],
      zero = origin.toPdf(0, 0),
      horizontal = origin.toPdf(1, 0),
      vertical = origin.toPdf(0, 1),
      toView = (x, y) => [
        (x - zero[0]) * (horizontal[0] - zero[0]) + (y - zero[1]) * (horizontal[1] - zero[1]),
        (x - zero[0]) * (vertical[0] - zero[0]) + (y - zero[1]) * (vertical[1] - zero[1])
      ],
      box = boundsBetween(toView(rect.x, rect.bottom), toView(rect.x + rect.width, rect.top))
    // Round outwards to include boundary pixels, using the admitted (possibly
    // trimmed) region. An extra margin would claim paint in neighboring figures.
    const left = Math.max(0, Math.floor((box.x * width) / size.width)),
      right = Math.min(width, Math.ceil(((box.x + box.width) * width) / size.width)),
      top = Math.max(0, Math.floor((box.bottom * height) / size.height)),
      bottom = Math.min(height, Math.ceil((box.top * height) / size.height))
    let overlaps = false
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) overlaps ||= alpha[y * width + x] > 0
    if (!overlaps) return false
    if (!sourceInk) return true
    // Native labels may already sit over a flat raster backdrop. Keep that
    // image intact and admit only its identical opaque color, both under the
    // original owned ink and throughout the proposed replacement rectangle.
    // Borders, transparent pixels and raster text still block replacement.
    const sourceBox = boundsBetween(
        toView(sourceInk.x, sourceInk.bottom),
        toView(sourceInk.x + sourceInk.width, sourceInk.top)
      ),
      x0 = Math.floor((sourceBox.x * width) / size.width),
      x1 = Math.ceil(((sourceBox.x + sourceBox.width) * width) / size.width),
      y0 = Math.floor((sourceBox.bottom * height) / size.height),
      y1 = Math.ceil((sourceBox.top * height) / size.height)
    if (x0 < 0 || y0 < 0 || x1 > width || y1 > height || x0 >= x1 || y0 >= y1) return true
    const color = colors[y0 * width + x0]
    for (const [a, b, c, d] of [
      [x0, x1, y0, y1],
      [left, right, top, bottom]
    ])
      for (let y = c; y < d; y++)
        for (let x = a; x < b; x++) {
          const index = y * width + x
          if (colors[index] >>> 24 !== 255 || colors[index] !== color) return true
        }
    return false
  }
  const fontNames = new Map()
  const nativeFontName = (object) => {
    const font = p.FPDFTextObj_GetFont(object.obj)
    if (!fontNames.has(font)) {
      const length = p.FPDFFont_GetBaseFontName(font, 0, 0)
      check(length > 0 && length < 512)
      const at = e.alloc(length)
      try {
        check(p.FPDFFont_GetBaseFontName(font, at, length) === length)
        fontNames.set(font, Buffer.from(e.m.HEAPU8.slice(at, at + length - 1)).toString('utf8'))
      } finally {
        e.free(at)
      }
    }
    return fontNames.get(font)
  }
  // Two extraction engines can name the same publisher hyphen differently.
  // Prove that ASCII '-' uses exactly the same native font, ink and geometry;
  // never make typographic hyphens globally equivalent or change page objects.
  const proveAsciiHyphens = (page, objects) => {
    for (const object of objects) {
      if (object.type !== 1 || !/^[‐‑]$/u.test(object.text.trim())) continue
      const at = e.alloc(24),
        text = e.bytes(Buffer.from('-\0', 'utf16le'))
      let clone
      const bitmaps = []
      try {
        const clip = p.FPDFPageObj_GetClipPath(object.obj)
        if (
          !p.FPDFPageObj_GetIsActive(object.obj, at) ||
          !e.m.HEAP32[at / 4] ||
          p.FPDFTextObj_GetTextRenderMode(object.obj) !== 0 ||
          (clip && p.FPDFClipPath_CountPaths(clip) > 0) ||
          !p.FPDFTextObj_GetFontSize(object.obj, at)
        )
          continue
        const size = e.m.HEAPF32[at / 4],
          font = p.FPDFTextObj_GetFont(object.obj)
        if (!font || !Number.isFinite(size) || size <= 0) continue
        clone = p.FPDFPageObj_CreateTextObj(input.doc, font, size)
        if (
          !clone ||
          p.FPDFTextObj_GetFont(clone) !== font ||
          !p.FPDFText_SetText(clone, text) ||
          !p.FPDFPageObj_GetMatrix(object.obj, at) ||
          !p.FPDFPageObj_SetMatrix(clone, at) ||
          !p.FPDFPageObj_GetFillColor(object.obj, at, at + 4, at + 8, at + 12) ||
          !p.FPDFPageObj_SetFillColor(clone, ...e.m.HEAPU32.slice(at / 4, at / 4 + 4)) ||
          e.bounds(clone).some((value, index) => value !== object.bounds[index])
        )
          continue
        const snapshot = (obj) => {
          const bitmap = p.FPDFTextObj_GetRenderedBitmap(input.doc, page, obj, 4)
          if (!bitmap) return undefined
          bitmaps.push(bitmap)
          const width = p.FPDFBitmap_GetWidth(bitmap),
            height = p.FPDFBitmap_GetHeight(bitmap),
            stride = p.FPDFBitmap_GetStride(bitmap),
            buffer = p.FPDFBitmap_GetBuffer(bitmap)
          if (
            !buffer ||
            width <= 0 ||
            height <= 0 ||
            stride < width * 4 ||
            stride * height > 1048576
          )
            return undefined
          return {
            width,
            height,
            stride,
            bytes: e.m.HEAPU8.slice(buffer, buffer + stride * height)
          }
        }
        const original = snapshot(object.obj),
          ascii = snapshot(clone)
        if (
          original &&
          ascii &&
          original.width === ascii.width &&
          original.height === ascii.height &&
          original.stride === ascii.stride &&
          original.bytes.some((value, index) => index % 4 === 3 && value > 0) &&
          original.bytes.every((value, index) => value === ascii.bytes[index])
        )
          object.asciiHyphenProven = true
      } finally {
        for (const bitmap of bitmaps) p.FPDFBitmap_Destroy(bitmap)
        if (clone) p.FPDFPageObj_Destroy(clone)
        e.free(text)
        e.free(at)
      }
    }
  }
  // ActualText can describe sentence case while the native glyphs paint capitals.
  // Read the painted spelling on an isolated copy; retain the original metadata.
  // Exact object-local marks, claimed source and unchanged native ink are required.
  const actualTextSources = new Map()
  const nestedActualTextSources = new Map()
  // Nested labels remain read-only. Limit this proof to unclipped identity Forms:
  // their object bounds are already in page coordinates, with no inferred transform.
  const actualTextObjects = (page, objects) => {
    if (!objects.some((object) => object.type === 5)) return objects
    const result = [...objects],
      text = p.FPDFText_LoadPage(page)
    check(text, 'source-mismatch')
    const at = e.alloc(24)
    const visit = (object, depth) => {
      if (
        object.type !== 5 ||
        depth >= 8 ||
        p.FPDFClipPath_CountPaths(p.FPDFPageObj_GetClipPath(object.obj)) !== -1 ||
        !p.FPDFPageObj_GetMatrix(object.obj, at) ||
        [1, 0, 0, 1, 0, 0].some((value, index) => e.m.HEAPF32[at / 4 + index] !== value)
      )
        return
      const count = p.FPDFFormObj_CountObjects(object.obj)
      if (count < 0 || result.length + count > 10000) return
      for (let index = 0; index < count; index++) {
        const obj = p.FPDFFormObj_GetObject(object.obj, index),
          child = { i: result.length, obj, type: p.FPDFPageObj_GetType(obj), bounds: e.bounds(obj) }
        result.push(child)
        if (child.type === 1) {
          const size = p.FPDFTextObj_GetText(obj, text, 0, 0)
          if (size <= 0 || size > 200000) continue
          const buffer = e.alloc(size)
          try {
            p.FPDFTextObj_GetText(obj, text, buffer, size)
            child.text = Buffer.from(e.m.HEAPU8.slice(buffer, buffer + size))
              .toString('utf16le')
              .replace(/\0$/u, '')
          } finally {
            e.free(buffer)
          }
        } else visit(child, depth + 1)
      }
    }
    try {
      for (const object of objects) visit(object, 0)
      return result
    } finally {
      e.free(at)
      p.FPDFText_ClosePage(text)
    }
  }
  const applyActualTextSources = (number, objects) => {
    for (const entry of actualTextSources.get(number) ?? []) {
      if (entry.nested) continue
      const object = objects[entry.index]
      check(
        object?.type === 1 &&
          object.text === entry.original &&
          object.bounds.every((value, axis) => value === entry.bounds[axis]),
        'source-mismatch'
      )
      object.text = entry.text
    }
  }
  const recoverActualTextSources = (number, objects, sourcePage) => {
    const expanded = actualTextObjects(sourcePage, objects)
    const claims = units
        .flatMap((unit) => unit.fragments)
        .filter((fragment) => fragment.pageNumber === number && fragment.items?.length),
      candidates = expanded.filter(
        (object) =>
          object.type === 1 &&
          typeof object.text === 'string' &&
          /^[A-Za-z ]{1,64}$/u.test(object.text) &&
          p.FPDFPageObj_CountMarks(object.obj) === 1 &&
          claims.some((fragment) => {
            const box = fragmentBounds(fragment)
            return (
              object.bounds[0] >= box.x - objectTolerance &&
              object.bounds[2] <= box.x + box.width + objectTolerance &&
              object.bounds[1] >= box.bottom - objectTolerance &&
              object.bounds[3] <= box.top + objectTolerance &&
              fragment.items.some(
                ({ text }) =>
                  text.trim() !== object.text.trim() &&
                  /^[A-Za-z ]{1,64}$/u.test(text) &&
                  text.trim().toLowerCase() === object.text.trim().toLowerCase()
              )
            )
          })
      )
    if (!candidates.length) return
    const copy = e.open(e.save(input.doc)),
      page = p.FPDF_LoadPage(copy.doc, number - 1),
      at = e.alloc(1024),
      length = e.alloc(8),
      entries = []
    const snapshot = (object) => {
      const bitmap = p.FPDFTextObj_GetRenderedBitmap(copy.doc, page, object.obj, 4)
      if (!bitmap) return undefined
      try {
        const width = p.FPDFBitmap_GetWidth(bitmap),
          height = p.FPDFBitmap_GetHeight(bitmap),
          stride = p.FPDFBitmap_GetStride(bitmap),
          buffer = p.FPDFBitmap_GetBuffer(bitmap)
        if (!buffer || width <= 0 || height <= 0 || stride < width * 4 || stride * height > 1048576)
          return undefined
        return { width, height, stride, bytes: e.m.HEAPU8.slice(buffer, buffer + stride * height) }
      } finally {
        p.FPDFBitmap_Destroy(bitmap)
      }
    }
    try {
      check(page)
      const cloned = actualTextObjects(page, e.objects(page))
      for (const original of candidates) {
        const object = cloned[original.i]
        if (
          object?.type !== 1 ||
          object.text !== original.text ||
          object.bounds.some((value, axis) => value !== original.bounds[axis]) ||
          p.FPDFPageObj_CountMarks(object.obj) !== 1 ||
          p.FPDFTextObj_GetTextRenderMode(object.obj) !== 0 ||
          p.FPDFClipPath_CountPaths(p.FPDFPageObj_GetClipPath(object.obj)) !== -1
        )
          continue
        const mark = p.FPDFPageObj_GetMark(object.obj, 0)
        if (
          p.FPDFPageObjMark_CountParams(mark) !== 1 ||
          !p.FPDFPageObjMark_GetParamStringValue(mark, 'ActualText', at, 1024, length)
        )
          continue
        const bytes = e.m.HEAPU32[length / 4]
        if (!bytes || bytes > 258 || bytes % 2) continue
        const marked = Buffer.from(e.m.HEAPU8.slice(at, at + bytes))
          .toString('utf16le')
          .replace(/\0$/u, '')
        // PDFium widens raw UTF-16BE PDF string bytes, including each zero byte.
        // Accept that exact ASCII representation as well as plain ASCII strings.
        const semantic = /^(?:\0[A-Za-z ]){1,64}$/u.test(marked)
          ? marked.replace(/\0/gu, '')
          : marked
        if (!/^[A-Za-z ]{1,64}$/u.test(semantic)) continue
        if (semantic.trim() !== original.text.trim()) continue
        const before = snapshot(object)
        if (!before || !p.FPDFPageObj_RemoveMark(object.obj, mark)) continue
        const painted = actualTextObjects(page, e.objects(page))[original.i],
          after = snapshot(painted)
        if (
          !/^[A-Za-z ]{1,64}$/u.test(painted.text) ||
          painted.text.trim() === original.text.trim() ||
          painted.text.trim().toLowerCase() !== original.text.trim().toLowerCase() ||
          painted.bounds.some((value, axis) => value !== original.bounds[axis]) ||
          !claims.some((fragment) => {
            const box = fragmentBounds(fragment)
            return (
              original.bounds[0] >= box.x - objectTolerance &&
              original.bounds[2] <= box.x + box.width + objectTolerance &&
              original.bounds[1] >= box.bottom - objectTolerance &&
              original.bounds[3] <= box.top + objectTolerance &&
              fragment.items.some(({ text }) => text.trim() === painted.text.trim())
            )
          }) ||
          !after ||
          before.width !== after.width ||
          before.height !== after.height ||
          before.stride !== after.stride ||
          !before.bytes.some((value, index) => index % 4 === 3 && value > 0) ||
          !before.bytes.every((value, index) => value === after.bytes[index])
        )
          continue
        entries.push({
          index: original.i,
          nested: original.i >= objects.length,
          original: original.text,
          text: painted.text,
          bounds: original.bounds
        })
      }
      actualTextSources.set(number, entries)
      applyActualTextSources(number, objects)
      if (entries.some((entry) => entry.nested)) {
        const corrected = new Map(
          entries.filter((entry) => entry.nested).map((entry) => [entry.index, entry.text])
        )
        nestedActualTextSources.set(
          number,
          expanded
            .slice(objects.length)
            .filter((object) => object.type === 1)
            .map((object) => ({
              ...object,
              original: object.text,
              text: corrected.get(object.i) ?? object.text
            }))
        )
      }
    } finally {
      e.free(at)
      e.free(length)
      if (page) p.FPDF_ClosePage(page)
      copy.close()
    }
  }
  // Existing publisher hit padding may exceed a tightly extracted text line.
  // Preserve only that original vertical envelope; moving it must never cover
  // additional neighboring ink. Glyph layout still uses the unchanged region.
  const linkFits = (rect, anchor, link) => {
    const tolerance = anchor.annotation ? objectTolerance : 0.001
    const bottom = anchor.overhang
      ? Math.min(rect.bottom - tolerance, anchor.annotation.bottom)
      : rect.bottom - tolerance
    const top = anchor.overhang
      ? Math.max(rect.top + tolerance, anchor.annotation.top)
      : rect.top + tolerance
    return (
      link.left >= rect.x - tolerance &&
      link.right <= rect.x + rect.width + tolerance &&
      link.bottom >= bottom - (anchor.overhang ? 0.001 : 0) &&
      link.top <= top + (anchor.overhang ? 0.001 : 0) &&
      (!anchor.overhang ||
        anchor.overhang.every(([left, low, right, high]) => {
          const x0 = Math.max(left, link.left),
            x1 = Math.min(right, link.right),
            y0 = Math.max(low, link.bottom),
            y1 = Math.min(high, link.top)
          return (
            x1 - x0 <= 0.01 ||
            y1 - y0 <= 0.01 ||
            (x0 >= anchor.annotation.left - 0.01 &&
              x1 <= anchor.annotation.right + 0.01 &&
              y0 >= anchor.annotation.bottom - 0.01 &&
              y1 <= anchor.annotation.top + 0.01)
          )
        }))
    )
  }
  const plans = []
  const fragmentBounds = (fragment) => {
    const size = pages[fragment.pageNumber - 1],
      r = fragment.rect,
      origin = geometry[fragment.pageNumber - 1]
    check(size && origin)
    return boundsBetween(
      origin.toPdf(r.x * size.width, r.y * size.height),
      origin.toPdf((r.x + r.width) * size.width, (r.y + r.height) * size.height)
    )
  }
  const retainRegions = (unit) => {
    // Even an unverified region owns its original space: neighboring replacements
    // must not delete objects that extend into it through the glyph tolerance.
    plans.push(
      ...unit.fragments.map((fragment) => ({
        fragment,
        rect: fragmentBounds(fragment),
        unchanged: true
      }))
    )
  }
  // Planning does not mutate page geometry. Reuse one live page and its object
  // snapshot, closing it on page changes and before the independent mutation pass.
  let planningSnapshot
  const closePlanningPage = () => {
    if (!planningSnapshot) return
    p.FPDF_ClosePage(planningSnapshot.page)
    planningSnapshot = undefined
  }
  const planningPage = (number) => {
    if (planningSnapshot?.number === number) return planningSnapshot
    closePlanningPage()
    const page = p.FPDF_LoadPage(input.doc, number - 1)
    check(page)
    try {
      const replacementRegions = units
        .filter((unit) => unit.source !== unit.translation)
        .flatMap((unit) => unit.fragments)
        .filter((fragment) => fragment.pageNumber === number)
        .map((fragment) => ({
          ...fragmentBounds(fragment),
          sourceItems: fragment.items?.map((item) => item.text) ?? []
        }))
      splitSharedTextRuns(e, input.doc, page, [
        ...replacementRegions,
        ...geometry[number - 1].links
          .filter(
            (link) =>
              link.wholeRegion &&
              replacementRegions.some(
                (region) =>
                  link.left >= region.x &&
                  link.right <= region.x + region.width &&
                  (link.bottom + link.top) / 2 >= region.bottom &&
                  (link.bottom + link.top) / 2 <= region.top
              )
          )
          .map((link) => ({
            x: link.left,
            width: link.right - link.left,
            bottom: link.bottom,
            top: link.top,
            nativeCitation: true
          }))
      ])
      const objects = e.objects(page)
      const { sources: overprintedSources, groups: overprintGroups } =
        recoverOverprintedTextSources(e, page, objects)
      for (const object of objects) object.text = overprintedSources.get(object.obj) ?? object.text
      recoverActualTextSources(number, objects, page)
      proveAsciiHyphens(page, objects)
      // Some publishers serialize an invisible discretionary hyphen as its own
      // text object. PDF.js omits it, while PDFium exposes U+00AD beside the real
      // hyphen or U+200B between words. Repeated U+200C can likewise be an
      // empty publisher positioning run omitted by PDF.js. Prove the complete native object and every
      // character have zero ink; any merged space also requires an empty bitmap.
      // Painted/merged letters
      // and unknown controls cannot use this source-matching exemption.
      const zeroInkPositioningMarkers = new Set()
      const candidates = new Map(
        objects
          .filter(
            (o) =>
              o.type === 1 &&
              /^\s*(?:[\u00ad\u200b]|\u200c{1,8})\s*$/u.test(o.text) &&
              o.bounds.every(Number.isFinite) &&
              o.bounds[1] === o.bounds[3]
          )
          .map((o) => [o.obj, o])
      )
      if (candidates.size) {
        const text = p.FPDFText_LoadPage(page),
          at = e.alloc(32),
          characters = new Map()
        check(text, 'source-mismatch')
        try {
          const count = p.FPDFText_CountChars(text)
          check(count >= 0 && count <= 100000, 'source-mismatch')
          for (let i = 0; i < count; i++) {
            const object = candidates.get(p.FPDFText_GetTextObject(text, i))
            if (!object) continue
            const entries = characters.get(object.i) ?? []
            const code = p.FPDFText_GetUnicode(text, i),
              char = String.fromCodePoint(code)
            const boxed = p.FPDFText_GetCharBox(text, i, at, at + 8, at + 16, at + 24)
            const [left, right, bottom, top] = e.m.HEAPF64.slice(at / 8, at / 8 + 4)
            entries.push({
              char,
              valid:
                boxed &&
                (code === 173 || code === 8203 || code === 8204 || /^\s$/u.test(char)) &&
                bottom === top &&
                bottom === object.bounds[1] &&
                left >= object.bounds[0] &&
                right <= object.bounds[2]
            })
            characters.set(object.i, entries)
          }
          for (const [index, entries] of characters) {
            const object = objects[index]
            if (!entries.every((x) => x.valid)) continue
            const characters = entries.map((x) => x.char).join('')
            // PDFium can append inferred whitespace to a positioning object.
            // Admit it only when both native bounds are one point and every
            // actual character is the same independently measured empty marker.
            if (
              /^[\u00ad\u200b]$/u.test(object.text.trim()) &&
              object.bounds[0] === object.bounds[2] &&
              characters.trim() === object.text.trim()
            ) {
              zeroInkPositioningMarkers.add(index)
              continue
            }
            if (characters !== object.text) continue
            // A thin space may share the same zero-height positioning object.
            // Its complete native character boxes and rendered alpha must prove
            // that no painted glyph is being omitted from source matching.
            const bitmap = p.FPDFTextObj_GetRenderedBitmap(input.doc, page, object.obj, 4)
            if (!bitmap) continue
            try {
              const width = p.FPDFBitmap_GetWidth(bitmap),
                height = p.FPDFBitmap_GetHeight(bitmap),
                stride = p.FPDFBitmap_GetStride(bitmap),
                buffer = p.FPDFBitmap_GetBuffer(bitmap)
              if (
                width > 0 &&
                height > 0 &&
                stride >= width * 4 &&
                stride * height < 1048576 &&
                !e.m.HEAPU8.slice(buffer, buffer + stride * height).some((v, i) => i % 4 === 3 && v)
              )
                zeroInkPositioningMarkers.add(index)
            } finally {
              p.FPDFBitmap_Destroy(bitmap)
            }
          }
        } finally {
          e.free(at)
          p.FPDFText_ClosePage(text)
        }
      }
      const macrons = objects.some((o) => o.type === 1 && o.text.trim() === '¯')
        ? resolveNativeMathAccents(
            objects
              .filter((o) => o.type === 1)
              .map((o) => ({
                ...o,
                fontName: nativeFontName(o)
              }))
          ).filter((accent) => objects[accent.accentIndex]?.text.trim() === '¯')
        : []
      planningSnapshot = {
        number,
        page,
        objects,
        macrons,
        zeroInkPositioningMarkers,
        overprintGroups
      }
      return planningSnapshot
    } catch (error) {
      p.FPDF_ClosePage(page)
      throw error
    }
  }
  const planUnit = (unit) => {
    const originalUnit = unit
    pageNumber = unit.fragments[0]?.pageNumber
    const unchanged =
      unit.source === unit.translation ||
      presentationText(unit.source) === presentationText(unit.translation)
    // Model line wrapping is presentation whitespace within an extracted unit.
    // Reflow it to the available PDF region without changing the saved answer.
    if (!unchanged)
      unit = {
        ...unit,
        // Format controls such as WORD JOINER are extraction artifacts. They
        // carry no visible content and are absent from the bundled output font.
        translation: normalizeOutputGlyphs(
          unit.translation
            .replace(/[\r\n]+/gu, ' ')
            .replace(/\p{Cf}/gu, '')
            // CJK labels do not require Latin word spacing around an operator.
            // Remove only whitespace; the saved wording and symbols stay intact.
            .replace(/(\p{Script=Han}) +([+−×÷=]) +(?=\p{Script=Han})/gu, '$1$2'),
          unit.source
        )
      }
    // A semantic paragraph may arrive as one fragment per publisher line. Treat
    // consecutive, aligned rows as one owned region so a wrapped native citation
    // is not pinned to two different regions. Keep columns, pages, gaps and rows
    // with intervening native objects separate; the normal native source,
    // ownership and collision checks still verify the resulting rectangle.
    const fragments = []
    for (const [fragmentIndex, fragment] of unit.fragments.entries()) {
      const previous = fragments.at(-1),
        a = previous?.rect,
        b = fragment.rect,
        page = pages[fragment.pageNumber - 1],
        gap = a ? b.y - a.y - a.height : Infinity
      if (
        previous?.pageNumber === fragment.pageNumber &&
        Math.abs(a.x - b.x) * page.width <= 0.5 &&
        (Math.abs(a.x + a.width - b.x - b.width) * page.width <= 0.5 ||
          // A paragraph's shorter final row owns the same column's blank tail,
          // provided the native object/link checks below prove it is empty.
          (fragmentIndex === unit.fragments.length - 1 &&
            b.width < a.width &&
            (unit.source.match(/[A-Za-z]{2,}/gu)?.length ?? 0) >= 8)) &&
        gap >= -0.05 / page.height &&
        gap <= Math.min(a.height, b.height) * 0.5
      ) {
        const left = Math.min(a.x, b.x),
          merged = {
            pageNumber: fragment.pageNumber,
            rect: {
              x: left,
              y: a.y,
              width: Math.max(a.x + a.width, b.x + b.width) - left,
              height: b.y + b.height - a.y
            }
          },
          bounds = fragmentBounds(merged),
          owned = [fragmentBounds(previous), fragmentBounds(fragment)],
          overlaps = (object, rect) =>
            object.bounds[0] < rect.x + rect.width &&
            object.bounds[2] > rect.x &&
            object.bounds[1] < rect.top &&
            object.bounds[3] > rect.bottom
        // Rectangles are the IPC contract: prove the new gap against actual native
        // objects instead of depending on optional renderer extraction-item IDs.
        if (
          planningPage(fragment.pageNumber).objects.some(
            (object) => overlaps(object, bounds) && !owned.some((rect) => overlaps(object, rect))
          ) ||
          geometry[fragment.pageNumber - 1].links.some((link) => {
            const object = { bounds: [link.left, link.bottom, link.right, link.top] }
            return overlaps(object, bounds) && !owned.some((rect) => overlaps(object, rect))
          })
        )
          fragments.push(fragment)
        else fragments[fragments.length - 1] = merged
      } else fragments.push(fragment)
    }
    unit = { ...unit, fragments }
    const regions = []
    let sourceCursor = 0
    for (const [index, fragment] of unit.fragments.entries()) {
      pageNumber = fragment.pageNumber
      check(
        index === 0 || fragment.pageNumber >= unit.fragments[index - 1].pageNumber,
        'multi-region'
      )
      const sourceRect = fragmentBounds(fragment),
        origin = geometry[fragment.pageNumber - 1]
      const { page, objects, macrons, zeroInkPositioningMarkers, overprintGroups } = planningPage(
        fragment.pageNumber
      )
      let sourceSize, sourcePoint, sourceColor, sourceBaseline, cos, sin
      let mixedSizes = false
      const proseColors = new Map()
      {
        let selected = objects.filter(
          (o) =>
            o.type === 1 &&
            o.bounds[0] < sourceRect.x + sourceRect.width &&
            o.bounds[2] > sourceRect.x &&
            o.bounds[1] < sourceRect.top &&
            o.bounds[3] > sourceRect.bottom &&
            o.bounds[0] >= sourceRect.x - objectTolerance &&
            o.bounds[2] <= sourceRect.x + sourceRect.width + objectTolerance &&
            o.bounds[3] <= sourceRect.top + objectTolerance &&
            o.bounds[1] >= sourceRect.bottom - objectTolerance
        )
        // A raised macron can enter the preceding line's font box. Its proven
        // mathematical base owns it; never claim it as neighboring prose.
        selected = selected.filter(
          (o) =>
            !macrons.some(
              (accent) =>
                accent.accentIndex === o.i && !selected.some((base) => base.i === accent.baseIndex)
            )
        )
        // PDF.js can report a fragment rectangle narrower than the complete
        // native text object (for example when a publisher draws one label in
        // a single run but the extractor clips its right side).  If the
        // intersecting object proves the fragment's complete source text, own
        // that object and use its exact ink bounds.  Never apply this to a
        // substring of a shared object: neighboring units must stay untouched.
        if (!unchanged && !selected.length) {
          const fragmentSource =
            fragment.items?.map((item) => item.text).join('') ??
            (unit.fragments.length === 1 ? unit.source : undefined)
          const exact = objects.filter(
            (o) =>
              o.type === 1 &&
              o.bounds[0] >= sourceRect.x - objectTolerance &&
              o.bounds[3] <= sourceRect.top + objectTolerance &&
              o.bounds[0] < sourceRect.x + sourceRect.width &&
              o.bounds[2] > sourceRect.x &&
              o.bounds[1] < sourceRect.top &&
              o.bounds[3] > sourceRect.bottom &&
              fragmentSource &&
              sourceMatches(fragmentSource, o.text)
          )
          if (exact.length === 1) {
            const object = exact[0]
            selected = [object]
            Object.assign(sourceRect, {
              x: object.bounds[0],
              bottom: object.bounds[1],
              width: object.bounds[2] - object.bounds[0],
              height: object.bounds[3] - object.bounds[1],
              top: object.bounds[3]
            })
          }
        }
        // PDFium can keep a leading punctuation mark in the same text object as
        // a paragraph whose extracted rectangle starts after that mark. Claim
        // that complete object only when the overhang is punctuation/space and
        // the remaining object text exactly proves the requested source.
        const leadingObjectPrefixes = new Map()
        if (!unchanged && !selected.length) {
          const candidate = objects.find((o) => {
            if (
              o.type !== 1 ||
              o.bounds[2] <= sourceRect.x ||
              o.bounds[0] >= sourceRect.x + sourceRect.width ||
              o.bounds[1] >= sourceRect.top ||
              o.bounds[3] <= sourceRect.bottom ||
              sourceRect.x - o.bounds[0] > Math.max(16, sourceRect.height * 1.5)
            )
              return false
            const match = /^(\s*[.,;:!?()[\]{}'"“”‘’]+\s*)/u.exec(o.text),
              fragmentSource = fragment.items?.map((item) => item.text).join('') ?? unit.source
            return match && sourceMatches(fragmentSource, o.text.slice(match[0].length))
          })
          if (candidate) {
            const match = /^(\s*[.,;:!?()[\]{}'"“”‘’]+\s*)/u.exec(candidate.text)
            if (match) {
              leadingObjectPrefixes.set(candidate.i, match[0])
              selected = [candidate]
              const right = /^[A-Za-z]{2,10},$/u.test(unit.source.trim())
                ? Math.max(sourceRect.x + sourceRect.width, candidate.bounds[2])
                : candidate.bounds[2]
              sourceRect.x = candidate.bounds[0]
              sourceRect.width = right - candidate.bounds[0]
              sourceRect.height = sourceRect.top - sourceRect.bottom
            }
          }
        }
        if (!unchanged && selected.length) {
          // PDF.js font boxes can graze a neighboring formula although its actual
          // ink is separated from all owned glyphs. Trim only empty edge space;
          // never claim or delete a partial neighboring text object.
          const ink = {
            left: Math.min(...selected.map((o) => o.bounds[0])),
            right: Math.max(...selected.map((o) => o.bounds[2])),
            bottom: Math.min(...selected.map((o) => o.bounds[1])),
            top: Math.max(...selected.map((o) => o.bounds[3]))
          }
          const boundaries = [
            ...objects
              .filter(
                (object) =>
                  !selected.includes(object) &&
                  (object.type === 1 ||
                    (object.type === 3 &&
                      Math.min(
                        object.bounds[2] - object.bounds[0],
                        object.bounds[3] - object.bounds[1]
                      ) <= 1))
              )
              .map((object) => ({
                bounds: object.bounds,
                required: object.type === 1,
                raster: object.type === 3
              })),
            ...units
              .filter((other) => other !== unit)
              .flatMap((other) => other.fragments)
              .filter((other) => other.pageNumber === fragment.pageNumber)
              .map((other) => {
                const box = fragmentBounds(other)
                return {
                  bounds: [box.x, box.bottom, box.x + box.width, box.top],
                  required: false
                }
              })
          ]
          for (const other of boundaries) {
            if (
              other.bounds[0] >= sourceRect.x + sourceRect.width ||
              other.bounds[2] <= sourceRect.x ||
              other.bounds[1] >= sourceRect.top ||
              other.bounds[3] <= sourceRect.bottom
            )
              continue
            // A tall glyph elsewhere on the line can raise the aggregate ink
            // box above a neighboring script without touching it. Admit only
            // the existing source-object tolerance, with every owned object
            // proven disjoint; generated ink must still fit the trimmed box.
            // A thin image rule may graze a font's top bound. Own the complete
            // source object as before, but fit new ink below the rule's outward
            // half-point paint pixel. Deeper crossings remain unsupported.
            const topRule =
              other.raster &&
              other.bounds[3] - other.bounds[1] <= 1 &&
              other.bounds[0] <= ink.left &&
              other.bounds[2] >= ink.right &&
              other.bounds[1] > ink.top - 0.5
            const trimTolerance =
                other.required &&
                selected.every(
                  (object) =>
                    object.bounds[0] >= other.bounds[2] ||
                    object.bounds[2] <= other.bounds[0] ||
                    object.bounds[1] >= other.bounds[3] ||
                    object.bounds[3] <= other.bounds[1]
                )
                  ? objectTolerance
                  : -0.02,
              right = sourceRect.x + sourceRect.width,
              candidates = [
                ...(topRule || other.bounds[1] > ink.top - trimTolerance
                  ? [
                      {
                        ...sourceRect,
                        top:
                          (topRule ? Math.floor(other.bounds[1] * 2) / 2 : other.bounds[1]) - 0.01
                      }
                    ]
                  : []),
                ...(other.bounds[3] < ink.bottom + trimTolerance
                  ? [{ ...sourceRect, bottom: other.bounds[3] + 0.01 }]
                  : []),
                ...(other.bounds[0] > ink.right + 0.02
                  ? [{ ...sourceRect, width: other.bounds[0] - 0.01 - sourceRect.x }]
                  : []),
                ...(other.bounds[2] < ink.left - 0.02
                  ? [
                      {
                        ...sourceRect,
                        x: other.bounds[2] + 0.01,
                        width: right - other.bounds[2] - 0.01
                      }
                    ]
                  : [])
              ].filter((candidate) => candidate.width > 0 && candidate.top > candidate.bottom)
            // Extraction boxes may overlap in whitespace. Reserve the neighbor's
            // box only when all owned ink stays inside; actual shared ink remains
            // subject to the strict global overlap guard below.
            if (!candidates.length && !other.required) continue
            check(candidates.length)
            candidates.sort((a, b) => b.width * (b.top - b.bottom) - a.width * (a.top - a.bottom))
            Object.assign(sourceRect, candidates[0])
            sourceRect.height = sourceRect.top - sourceRect.bottom
          }
        }
        const sizes = new Map(),
          objectBaselines = new Map()
        let horizontalSource = true
        const metrics = e.alloc(24)
        try {
          for (const object of selected) {
            check(p.FPDFPageObj_GetMatrix(object.obj, metrics))
            const [a, b, c, d, x, y] = e.m.HEAPF32.slice(metrics / 4, metrics / 4 + 6)
            horizontalSource &&= a > 0 && d > 0 && Math.abs(b) < 0.000001 && Math.abs(c / d) <= 0.3
            const scale = Math.hypot(a, b)
            objectBaselines.set(object.i, (-b / scale) * x + (a / scale) * y)
            check(p.FPDFTextObj_GetFontSize(object.obj, metrics))
            sizes.set(object.i, e.m.HEAPF32[metrics / 4] * Math.hypot(a, b))
          }
        } finally {
          e.free(metrics)
        }
        // Some fonts encode a small raised registration glyph in a much larger
        // em. Its ink, not that em, identifies the mark beside an unchanged brand.
        const registeredMarks = new Map(),
          ordinaryBodySize = Math.max(
            ...selected.filter((object) => object.text.trim() !== '®').map((o) => sizes.get(o.i))
          )
        if (horizontalSource && Number.isFinite(ordinaryBodySize)) {
          for (const object of selected.filter((o) => o.text.trim() === '®')) {
            const neighbors = selected.filter((other) => {
              const brand = other.text.trim().match(/[A-Za-z][A-Za-z0-9-]{1,39}$/u)?.[0],
                baseline = objectBaselines.get(other.i),
                point = sizes.get(other.i)
              if (!brand || Math.abs(point - ordinaryBodySize) >= 0.01) return false
              const label = brand + '®',
                occurrences = (text) => [
                  ...text.matchAll(new RegExp('(?<![A-Za-z0-9-])' + label, 'gu'))
                ],
                from = occurrences(unit.source),
                to = occurrences(unit.translation)
              return (
                from.length > 0 &&
                from.length === to.length &&
                nativeMathSymbolText(object, nativeFontName(object)).trim() === '®' &&
                object.bounds[0] >= other.bounds[2] &&
                object.bounds[0] - other.bounds[2] <= point * 0.4 &&
                sizes.get(object.i) > point * 1.25 &&
                sizes.get(object.i) <= point * 2.5 &&
                object.bounds[1] >= baseline + point * 0.15 &&
                object.bounds[3] <= baseline + point * 1.05 &&
                object.bounds[3] - object.bounds[1] >= point * 0.2 &&
                object.bounds[3] - object.bounds[1] <= point * 0.65 &&
                object.bounds[2] - object.bounds[0] >= point * 0.2 &&
                object.bounds[2] - object.bounds[0] <= point * 0.7
              )
            })
            if (neighbors.length === 1) registeredMarks.set(object.i, neighbors[0])
          }
          if (registeredMarks.size) {
            const text = p.FPDFText_LoadPage(page),
              at = e.alloc(32),
              characters = new Map([...registeredMarks.keys()].map((index) => [index, []])),
              candidates = new Map(
                selected.filter((o) => registeredMarks.has(o.i)).map((o) => [o.obj, o])
              )
            check(text, 'source-mismatch')
            try {
              const count = p.FPDFText_CountChars(text)
              check(count >= 0 && count <= 100000, 'source-mismatch')
              for (let index = 0; index < count; index++) {
                const object = candidates.get(p.FPDFText_GetTextObject(text, index))
                if (!object) continue
                const code = p.FPDFText_GetUnicode(text, index),
                  boxed = p.FPDFText_GetCharBox(text, index, at, at + 8, at + 16, at + 24),
                  [left, right, bottom, top] = e.m.HEAPF64.slice(at / 8, at / 8 + 4)
                characters
                  .get(object.i)
                  .push(
                    code === 174 &&
                      boxed &&
                      [left, bottom, right, top].every(
                        (value, i) =>
                          Number.isFinite(value) && Math.abs(value - object.bounds[i]) < 0.0001
                      )
                  )
              }
              for (const [index, glyphs] of characters)
                if (glyphs.length !== 1 || !glyphs[0]) registeredMarks.delete(index)
            } finally {
              e.free(at)
              p.FPDFText_ClosePage(text)
            }
          }
        }
        let bodySize = Math.max(
            ...selected.filter((o) => !registeredMarks.has(o.i)).map((o) => sizes.get(o.i))
          ),
          dropCap
        const [capital, opening] = selected.filter((object) => object.text.trim()),
          openingWord = opening?.text.trim().match(/^[a-z][A-Za-z]*/u)?.[0],
          openingSize = opening && sizes.get(opening.i)
        if (
          horizontalSource &&
          /^[A-Z]$/u.test(capital?.text.trim() ?? '') &&
          openingWord &&
          unit.source.trimStart().startsWith(capital.text.trim() + openingWord) &&
          sizes.get(capital.i) >= openingSize * 2 &&
          sizes.get(capital.i) <= openingSize * 5 &&
          selected.every(
            (object) => object === capital || sizes.get(object.i) <= openingSize * 1.05
          )
        ) {
          const font = p.FPDFTextObj_GetFont(opening.obj),
            rows = []
          for (const object of selected) {
            if (
              object === capital ||
              !object.text.trim() ||
              p.FPDFTextObj_GetFont(object.obj) !== font ||
              Math.abs(sizes.get(object.i) - openingSize) >= 0.01
            )
              continue
            const baseline = objectBaselines.get(object.i)
            let row = rows.find((row) => Math.abs(row.baseline - baseline) < 0.02)
            if (!row) rows.push((row = { baseline, left: Infinity, top: -Infinity }))
            row.left = Math.min(row.left, object.bounds[0])
            row.top = Math.max(row.top, object.bounds[3])
          }
          rows.sort((left, right) => right.baseline - left.baseline)
          const inset = rows.slice(0, 3),
            following = rows[3]
          // A decorative initial spans three indented lines of one native font.
          // A fourth line resumes at its left edge below all capital ink. This
          // identifies a drop cap without reclassifying a heading or a formula.
          if (
            inset.length === 3 &&
            following &&
            inset.every(
              (row, index) =>
                row.left >= capital.bounds[2] - 0.05 &&
                Math.abs(row.left - inset[0].left) <= openingSize * 0.2 &&
                (!index ||
                  (inset[index - 1].baseline - row.baseline >= openingSize * 0.9 &&
                    inset[index - 1].baseline - row.baseline <= openingSize * 1.6))
            ) &&
            capital.bounds[3] >= inset[0].baseline + openingSize * 0.4 &&
            capital.bounds[1] <= inset[2].baseline + openingSize * 0.1 &&
            following.top < capital.bounds[1] &&
            Math.abs(following.left - capital.bounds[0]) <= openingSize * 0.25
          ) {
            dropCap = capital
            bodySize = openingSize
          }
        }
        const bodyBaselines = selected
          .filter(
            (o) => o !== dropCap && !registeredMarks.has(o.i) && sizes.get(o.i) >= bodySize * 0.9
          )
          .map((o) => objectBaselines.get(o.i))
        const fractionItems = selected.map((object) => ({
          ...object,
          fontSize: sizes.get(object.i),
          baseline: objectBaselines.get(object.i)
        }))
        const fractions = [...new Set(bodyBaselines)]
          .flatMap((baseline) =>
            resolveInlineFractions(fractionItems, baseline, bodySize).map((fraction) => ({
              ...fraction,
              baseline
            }))
          )
          .filter(
            (fraction, i, all) =>
              all.findIndex((other) => other.numerator === fraction.numerator) === i &&
              unit.source.includes(fraction.label)
          )
          .flatMap((fraction) => {
            const numerator = selected.find((object) => object.i === fraction.numerator),
              denominator = selected.filter((object) => fraction.denominator.includes(object.i)),
              bars = objects.filter(
                (object) =>
                  [2, 3].includes(object.type) &&
                  object.bounds[3] - object.bounds[1] > 0 &&
                  object.bounds[3] - object.bounds[1] < bodySize * 0.1 &&
                  object.bounds[1] > Math.max(...denominator.map((item) => item.bounds[3])) &&
                  object.bounds[3] < numerator.bounds[1] &&
                  Math.abs(object.bounds[0] - fraction.bounds[0]) < bodySize * 0.15 &&
                  Math.abs(object.bounds[2] - fraction.bounds[2]) < bodySize * 0.15
              )
            if (bars.length !== 1) return []
            let textIndices = fraction.indices,
              label = fraction.label,
              bounds = [
                Math.min(fraction.bounds[0], bars[0].bounds[0]),
                fraction.bounds[1],
                Math.max(fraction.bounds[2], bars[0].bounds[2]),
                fraction.bounds[3]
              ]
            // Computer Modern's extensible floor delimiters occupy legacy j/k
            // slots. Only retain the paired, tall delimiters immediately enclosing
            // this independently verified fraction; ordinary j/k remain letters.
            const floorLabel = new RegExp(
              '⌊\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*⌋',
              'u'
            ).exec(unit.source)?.[0]
            if (floorLabel) {
              const candidates = selected.filter(
                  (o) =>
                    /^[jk]$/u.test(o.text.trim()) &&
                    /^(?:[A-Z]{6}\+)?CMEX(?:7|8|9|10|12)$/u.test(nativeFontName(o)) &&
                    o.bounds[1] <= bounds[1] &&
                    o.bounds[3] >= bounds[3] &&
                    o.bounds[3] - o.bounds[1] > bodySize &&
                    o.bounds[2] - o.bounds[0] < bodySize * 0.4
                ),
                left = candidates.filter(
                  (o) =>
                    o.text.trim() === 'j' &&
                    o.bounds[2] <= bounds[0] &&
                    bounds[0] - o.bounds[2] < bodySize * 0.8
                ),
                right = candidates.filter(
                  (o) =>
                    o.text.trim() === 'k' &&
                    o.bounds[0] >= bounds[2] &&
                    o.bounds[0] - bounds[2] < bodySize * 0.8
                )
              if (left.length === 1 && right.length === 1) {
                textIndices = [...fraction.indices, left[0].i, right[0].i].sort((a, b) => a - b)
                label = floorLabel
                bounds = [
                  left[0].bounds[0],
                  Math.min(left[0].bounds[1], right[0].bounds[1]),
                  right[0].bounds[2],
                  Math.max(left[0].bounds[3], right[0].bounds[3])
                ]
              }
            }
            return [
              {
                ...fraction,
                label,
                textIndices,
                indices: [...textIndices, bars[0].i].sort((a, b) => a - b),
                graphicIndices: [bars[0].i],
                bounds
              }
            ]
          })
        const radicals = [],
          underlines = [],
          preservedGraphics = fractions.flatMap((fraction) => fraction.graphicIndices)
        const latinAccent = selected.some((o) => o.text.trim() === '¨')
        const accentObjects =
          latinAccent || /[\u0302ˆ¯˜]/u.test(unit.source)
            ? selected.map((o) => {
                if (!latinAccent)
                  return {
                    ...o,
                    fontName: nativeFontName(o),
                    size: sizes.get(o.i),
                    glyphs: undefined
                  }
                const at = e.alloc(4)
                try {
                  check(p.FPDFTextObj_GetFontSize(o.obj, at))
                  return {
                    ...o,
                    fontName: nativeFontName(o),
                    fontIdentity: p.FPDFTextObj_GetFont(o.obj),
                    size: e.m.HEAPF32[at / 4],
                    glyphs: undefined
                  }
                } finally {
                  e.free(at)
                }
              })
            : []
        if (
          latinAccent ||
          accentObjects.some((o) => /CMEX/u.test(o.fontName) && /^[be]$/u.test(o.text.trim()))
        ) {
          const text = p.FPDFText_LoadPage(page),
            at = e.alloc(32)
          check(text, 'source-mismatch')
          try {
            const positions = new Map(accentObjects.map((o) => [o.obj, { object: o, cursor: 0 }])),
              count = p.FPDFText_CountChars(text)
            check(count >= 0 && count <= 100000, 'source-mismatch')
            for (let index = 0; index < count; index++) {
              const position = positions.get(p.FPDFText_GetTextObject(text, index)),
                code = p.FPDFText_GetUnicode(text, index)
              if (!position || !code || code === 10 || code === 13) continue
              const char = String.fromCodePoint(code),
                offset = position.object.text.indexOf(char, position.cursor)
              if (offset < 0) continue
              position.cursor = offset + char.length
              if (!p.FPDFText_GetCharBox(text, index, at, at + 8, at + 16, at + 24)) continue
              const [left, right, bottom, top] = e.m.HEAPF64.slice(at / 8, at / 8 + 4)
              if (![left, right, bottom, top].every(Number.isFinite)) continue
              ;(position.object.glyphs ??= []).push({
                text: char,
                offset,
                bounds: [left, bottom, right, top]
              })
            }
          } finally {
            e.free(at)
            p.FPDFText_ClosePage(text)
          }
        }
        const accents = /[\u0302ˆ¯˜]/u.test(unit.source)
          ? resolveNativeMathAccents(accentObjects)
              .map((accent) => ({
                ...accent,
                label: accent.labels.find((label) => unit.source.includes(label))
              }))
              .filter((accent) => accent.label)
          : []
        const latinAccents = resolveNativeLatinAccents(accentObjects),
          latinText = new Map(selected.map((o) => [o.i, o.text]))
        for (const accent of latinAccents) {
          latinText.set(accent.accentIndex, '')
          const text = latinText.get(accent.baseIndex)
          latinText.set(
            accent.baseIndex,
            text.slice(0, accent.offset) + accent.letter + text.slice(accent.offset + 1)
          )
        }
        const unchangedTransposeIndices = unchanged
          ? nativeTransposeSourceIndices(
              selected.map((object) => ({
                ...object,
                fontName: nativeFontName(object),
                size: sizes.get(object.i),
                baseline: objectBaselines.get(object.i)
              })),
              unit.source
            )
          : []
        const matchingObjects = selected.map((native) => {
          const object = {
            ...native,
            text: leadingObjectPrefixes.has(native.i)
              ? native.text.slice(leadingObjectPrefixes.get(native.i).length)
              : zeroInkPositioningMarkers.has(native.i)
                ? ''
                : unchangedTransposeIndices.includes(native.i)
                  ? 'ᵀ'
                  : latinAccents.some((accent) => accent.indices.includes(native.i))
                    ? latinText.get(native.i)
                    : nativeMathSymbolText(native, nativeFontName(native))
          }

          const accent = [...accents, ...fractions].find((candidate) =>
            candidate.indices.includes(object.i)
          )
          // Legacy math-symbol fonts can expose delimiter/relation slots as
          // ordinary Latin letters (e.g. TeX-matha's p/q/P/r). An unchanged
          // extracted spelling is not a semantic proof for repainting them.
          // Keep the complete source unit unless an existing native resolver
          // proves this whole object; ordinary prose/italic math fonts are exempt.
          check(
            unchanged ||
              accent ||
              nativeMathAlphabet(native, nativeFontName(native)) ||
              nativeMathSymbolText(native, nativeFontName(native)) !== native.text ||
              !/^(?:[A-Z]{6}\+)?(?:TeX-math[a-z]*|CMSY|CMEX)(?:5|6|7|8|9|10|12)$/u.test(
                nativeFontName(native)
              ) ||
              !/[A-Za-z0-9]/u.test(native.text),
            'unsupported-layout'
          )
          return accent
            ? {
                ...object,
                text: object.i === (accent.textIndices ?? accent.indices)[0] ? accent.label : ''
              }
            : object
        })
        const occupiedSource = selected.map((object) => object.bounds)
        const sourceInk =
          horizontalSource && selected.length
            ? boundsBetween(
                [
                  Math.min(...occupiedSource.map((box) => box[0])) - 0.01,
                  Math.min(...occupiedSource.map((box) => box[1])) - 0.01
                ],
                [
                  Math.max(...occupiedSource.map((box) => box[2])) + 0.01,
                  Math.max(...occupiedSource.map((box) => box[3])) + 0.01
                ]
              )
            : undefined
        if (unchanged) {
          // Read-only fragments may be part of a larger object or nested in a Form.
          // Verify the visible region without requiring ownership to delete it.
          const text = p.FPDFText_LoadPage(page)
          check(text, 'source-mismatch')
          let at
          try {
            const args = [
              text,
              sourceRect.x,
              sourceRect.top,
              sourceRect.x + sourceRect.width,
              sourceRect.bottom
            ]
            const count = p.FPDFText_GetBoundedText(...args, 0, 0)
            check(Number.isInteger(count) && count > 0 && count <= 100000, 'source-mismatch')
            at = e.alloc((count + 1) * 2)
            check(
              p.FPDFText_GetBoundedText(...args, at, count + 1) === count + 1,
              'source-mismatch'
            )
            const boundedSource = Buffer.from(e.m.HEAPU8.slice(at, at + count * 2)).toString(
                'utf16le'
              ),
              nested = (nestedActualTextSources.get(fragment.pageNumber) ?? []).filter(
                (object) =>
                  object.bounds[0] >= sourceRect.x - 0.05 &&
                  object.bounds[2] <= sourceRect.x + sourceRect.width + 0.05 &&
                  object.bounds[1] >= sourceRect.bottom - 0.05 &&
                  object.bounds[3] <= sourceRect.top + 0.05
              )
            regions.push({
              fragment,
              rect: sourceRect,
              source: boundedSource,
              // Require the entire bounded native spelling before substituting
              // independently verified marks; no partial/neighbor text is omitted.
              nestedSource:
                !selected.length &&
                nested.length &&
                sourceMatches(boundedSource, nested.map((object) => object.original).join(''))
                  ? nested.map((object) => object.text).join('')
                  : undefined,
              objectSource: matchingObjects.map((o) => o.text).join(''),
              sourceObjects: matchingObjects,
              containedSource: matchingObjects
                .filter(
                  (o) =>
                    o.bounds[0] >= sourceRect.x - objectTolerance &&
                    o.bounds[2] <= sourceRect.x + sourceRect.width + objectTolerance &&
                    o.bounds[3] <= sourceRect.top + 0.05 &&
                    o.bounds[1] >= sourceRect.bottom - 0.05
                )
                .map((o) => o.text)
                .join(''),
              objectIndices: selected.map((o) => o.i),
              collisionRect:
                // Each read-only fragment still participates in the aggregate source
                // proof below; an exact complete native run also proves its ink bounds.
                sourceMatches(
                  unit.fragments.length === 1
                    ? unit.source
                    : Buffer.from(e.m.HEAPU8.slice(at, at + count * 2)).toString('utf16le'),
                  matchingObjects.map((o) => o.text).join(''),
                  origin.verifiedHyphens(sourceRect)
                )
                  ? sourceInk
                  : undefined,
              unchanged
            })
          } finally {
            if (at) e.free(at)
            p.FPDFText_ClosePage(text)
          }
          continue
        }
        // No complete top-level text object may mean a nested Form or a partial object.
        // The unchanged fallback must still independently verify the bounded source text.
        check(selected.length, preserveUnsupported ? 'unsupported-layout' : 'source-mismatch')
        if (!unchanged) {
          // An inline underscore or radical bar can be a stroked path between native text
          // objects. Reflowing only the text strands that semantic mark over
          // unrelated prose. Keep the unit until the complete identifier has
          // proven text/path ownership; fraction bars already have that proof.
          if (horizontalSource) {
            const byIndex = new Map(selected.map((o) => [o.i, o])),
              at = e.alloc(32)
            try {
              for (const mark of objects) {
                if (mark.type !== 2 || preservedGraphics.includes(mark.i)) continue
                const before = byIndex.get(mark.i - 1),
                  after = byIndex.get(mark.i + 1),
                  point = sizes.get(before?.i),
                  baseline = objectBaselines.get(before?.i),
                  [left, bottom, right, top] = mark.bounds
                if (
                  !before ||
                  !after ||
                  !Number.isFinite(point) ||
                  point <= 0 ||
                  Math.abs(sizes.get(after.i) - point) > point * 0.01 ||
                  top - bottom > point * 0.15 ||
                  p.FPDFPath_CountSegments(mark.obj) !== 2
                )
                  continue
                const underscore =
                    /[A-Za-z0-9]\s*$/u.test(before.text) &&
                    /^\s*[A-Za-z0-9]/u.test(after.text) &&
                    Math.abs(objectBaselines.get(after.i) - baseline) <= point * 0.01 &&
                    right - left >= point * 0.2 &&
                    right - left <= point * 0.8 &&
                    Math.abs((bottom + top) / 2 - baseline) <= point * 0.15 &&
                    left - before.bounds[2] >= -point * 0.1 &&
                    left - before.bounds[2] <= point * 0.3 &&
                    after.bounds[0] - right >= -point * 0.1 &&
                    after.bounds[0] - right <= point * 0.3 &&
                    nativeFontName(before) &&
                    nativeFontName(before) === nativeFontName(after),
                  // TeX can paint the radical's overbar between the root glyph
                  // and its radicand. Its baseline is near the root's top, not
                  // the prose baseline. Preserve the whole unit until this path
                  // can move together with its proven native mathematical group.
                  radical =
                    nativeMathSymbolText(before, nativeFontName(before)).trim() === '√' &&
                    /^[A-Za-zα-ωΑ-Ω0-9]{1,8}$/u.test(after.text.trim()) &&
                    right - left >= point * 0.2 &&
                    right - left <= point * 5 &&
                    Math.abs(left - before.bounds[2]) <= point * 0.15 &&
                    Math.abs((bottom + top) / 2 - before.bounds[3]) <= point * 0.15 &&
                    Math.abs(left - after.bounds[0]) <= point * 0.15 &&
                    Math.abs(right - after.bounds[2]) <= point * 0.15 &&
                    bottom >= after.bounds[3] &&
                    bottom - after.bounds[3] <= point * 0.3 &&
                    after.bounds[1] >= before.bounds[1] - point * 0.15 &&
                    after.bounds[1] <= before.bounds[1] + point * 0.3
                if (!underscore && !radical) continue
                const clip = p.FPDFPageObj_GetClipPath(mark.obj)
                if (clip && p.FPDFClipPath_CountPaths(clip) > 0) continue
                check(p.FPDFPageObj_GetIsActive(mark.obj, at))
                if (!e.m.HEAP32[at / 4]) continue
                check(p.FPDFPath_GetDrawMode(mark.obj, at, at + 4))
                if (e.m.HEAP32[at / 4] || !e.m.HEAP32[at / 4 + 1]) continue
                check(p.FPDFPageObj_GetStrokeColor(mark.obj, at, at + 4, at + 8, at + 12))
                if (!e.m.HEAPU32[at / 4 + 3]) continue
                check(p.FPDFPageObj_GetMatrix(mark.obj, at))
                const [a, b, c, d] = e.m.HEAPF32.slice(at / 4, at / 4 + 4),
                  start = p.FPDFPath_GetPathSegment(mark.obj, 0),
                  end = p.FPDFPath_GetPathSegment(mark.obj, 1)
                if (p.FPDFPathSegment_GetType(start) !== 2 || p.FPDFPathSegment_GetType(end) !== 0)
                  continue
                check(p.FPDFPathSegment_GetPoint(start, at, at + 4))
                check(p.FPDFPathSegment_GetPoint(end, at + 8, at + 12))
                const [x1, y1, x2, y2] = e.m.HEAPF32.slice(at / 4, at / 4 + 4)
                // Judge the painted direction, independent of draw order or
                // whether the PDF rotates a local vertical path into a line.
                const dx = a * (x2 - x1) + c * (y2 - y1),
                  dy = b * (x2 - x1) + d * (y2 - y1)
                if (Math.abs(dx) < 0.000001 || Math.abs(dy) > 0.000001) continue
                if (!radical) check(false, 'unsupported-layout')
                radicals.push({
                  radical: true,
                  label: '√' + after.text.trim(),
                  indices: [before.i, mark.i, after.i],
                  textIndices: [before.i, after.i],
                  graphicIndices: [mark.i],
                  baseline: objectBaselines.get(after.i),
                  bounds: [
                    Math.min(before.bounds[0], left, after.bounds[0]),
                    Math.min(before.bounds[1], bottom, after.bounds[1]),
                    Math.max(before.bounds[2], right, after.bounds[2]),
                    Math.max(before.bounds[3], top, after.bounds[3])
                  ]
                })
                preservedGraphics.push(mark.i)
              }
            } finally {
              e.free(at)
            }
            if (radicals.length)
              check(
                selected.every(
                  (object) =>
                    nativeMathSymbolText(object, nativeFontName(object)).trim() !== '√' ||
                    radicals.some((radical) => radical.textIndices[0] === object.i)
                ),
                'unsupported-layout'
              )
          }
          const left = Math.min(...selected.map((o) => o.bounds[0])),
            right = Math.max(...selected.map((o) => o.bounds[2])),
            bottom = Math.min(...selected.map((o) => o.bounds[1])),
            top = Math.max(...selected.map((o) => o.bounds[3])),
            rules = objects.filter(
              (o) =>
                o.type === 2 &&
                ((o.bounds[2] - o.bounds[0] <= 2 &&
                  // Keep the existing interior-cell proof narrow. Thicker plot
                  // strokes may intentionally overlap original labels; use them
                  // only to bound whitespace outside all owned ink.
                  (o.bounds[2] - o.bounds[0] <= 1 ||
                    o.bounds[0] > right + 0.02 ||
                    o.bounds[2] < left - 0.02) &&
                  o.bounds[0] > sourceRect.x &&
                  o.bounds[2] < sourceRect.x + sourceRect.width &&
                  o.bounds[1] <= bottom &&
                  o.bounds[3] >= top) ||
                  // A thin rule spanning the complete native label bounds its
                  // row. Return borrowed space below it even when the new
                  // glyphs would sit on opposite sides without touching it.
                  (o.bounds[3] - o.bounds[1] <= 2 &&
                    o.bounds[0] <= left &&
                    o.bounds[2] >= right &&
                    o.bounds[3] < bottom - 0.02 &&
                    o.bounds[3] > sourceRect.bottom))
            )
          // A painted vertical cell rule inside a text region proves separate
          // columns. Reflowing the whole row would move values into other cells.
          const at = e.alloc(16)
          try {
            for (const rule of rules) {
              check(p.FPDFPath_GetDrawMode(rule.obj, at, at + 4))
              const [fill, stroke] = e.m.HEAP32.slice(at / 4, at / 4 + 2)
              let visible = false
              if (fill) {
                check(p.FPDFPageObj_GetFillColor(rule.obj, at, at + 4, at + 8, at + 12))
                visible ||= e.m.HEAPU32[at / 4 + 3] > 0
              }
              if (stroke) {
                check(p.FPDFPageObj_GetStrokeColor(rule.obj, at, at + 4, at + 8, at + 12))
                visible ||= e.m.HEAPU32[at / 4 + 3] > 0
              }
              if (!visible) continue
              if (rule.bounds[3] < bottom - 0.02) {
                sourceRect.bottom = Math.max(sourceRect.bottom, rule.bounds[3] + 0.5)
                sourceRect.height = sourceRect.top - sourceRect.bottom
                continue
              }
              // A cell boundary can sit inside borrowed whitespace without
              // crossing the original ink. Return that space before fitting;
              // a rule through the owned text still rejects the whole region.
              if (rule.bounds[0] > right + 0.02) {
                sourceRect.width = Math.min(sourceRect.width, rule.bounds[0] - 0.5 - sourceRect.x)
              } else if (rule.bounds[2] < left - 0.02) {
                const end = sourceRect.x + sourceRect.width
                sourceRect.x = Math.max(sourceRect.x, rule.bounds[2] + 0.5)
                sourceRect.width = end - sourceRect.x
              } else check(false, 'unsupported-layout')
            }
          } finally {
            e.free(at)
          }
        }
        // A publisher can paint a run-in label's underline as a tiny image.
        // Own and move the complete label/decoration together; never exempt a
        // diagram merely because it is thin or happens to touch source text.
        if (horizontalSource) {
          const label = selected[0],
            point = sizes.get(label?.i),
            baseline = objectBaselines.get(label?.i),
            mark = objects.find((object) => object.i === label?.i + 1),
            after = selected.find((object) => object.i === label?.i + 2)
          if (
            label &&
            /^[A-Z][A-Za-z]{1,11}$/u.test(label.text.trim()) &&
            mark?.type === 3 &&
            after &&
            /^:\s+\p{L}/u.test(after.text) &&
            [point, baseline, ...mark.bounds].every(Number.isFinite) &&
            point > 0 &&
            Math.abs(sizes.get(after.i) - point) < point * 0.01 &&
            Math.abs(objectBaselines.get(after.i) - baseline) < point * 0.01 &&
            Math.abs(mark.bounds[0] - label.bounds[0]) < point * 0.05 &&
            Math.abs(mark.bounds[2] - label.bounds[2]) < point * 0.05 &&
            mark.bounds[2] - mark.bounds[0] >= point &&
            mark.bounds[3] - mark.bounds[1] > 0 &&
            mark.bounds[3] - mark.bounds[1] < point * 0.08 &&
            mark.bounds[3] < label.bounds[1] &&
            label.bounds[1] - mark.bounds[3] < point * 0.2 &&
            objects.filter(
              (object) =>
                object.type === 1 &&
                Math.abs(object.bounds[0] - mark.bounds[0]) < point * 0.05 &&
                Math.abs(object.bounds[2] - mark.bounds[2]) < point * 0.05 &&
                object.bounds[1] > mark.bounds[3] &&
                object.bounds[1] - mark.bounds[3] < point * 0.2
            ).length === 1
          ) {
            const at = e.alloc(32)
            let bitmap
            try {
              const clipped = [label, mark, after].some((object) => {
                const clip = p.FPDFPageObj_GetClipPath(object.obj)
                return clip && p.FPDFClipPath_CountPaths(clip) > 0
              })
              check(p.FPDFPageObj_GetMatrix(mark.obj, at))
              const matrix = [...e.m.HEAPF32.slice(at / 4, at / 4 + 6)]
              check(p.FPDFPageObj_GetIsActive(mark.obj, at))
              const active = !!e.m.HEAP32[at / 4]
              check(p.FPDFPageObj_GetFillColor(label.obj, at, at + 4, at + 8, at + 12))
              const [red, green, blue, alpha] = e.m.HEAPU32.slice(at / 4, at / 4 + 4)
              if (
                !clipped &&
                active &&
                matrix.every(Number.isFinite) &&
                matrix[0] > 0 &&
                matrix[1] === 0 &&
                matrix[2] === 0 &&
                matrix[3] !== 0 &&
                alpha === 255
              ) {
                bitmap = p.FPDFImageObj_GetRenderedBitmap(input.doc, page, mark.obj)
                if (bitmap) {
                  const width = p.FPDFBitmap_GetWidth(bitmap),
                    height = p.FPDFBitmap_GetHeight(bitmap),
                    stride = p.FPDFBitmap_GetStride(bitmap),
                    buffer = p.FPDFBitmap_GetBuffer(bitmap)
                  let solid =
                    p.FPDFBitmap_GetFormat(bitmap) === 4 &&
                    width > 0 &&
                    height > 0 &&
                    width * height <= 4096 &&
                    stride >= width * 4 &&
                    buffer > 0
                  for (let y = 0; solid && y < height; y++)
                    for (let x = 0; solid && x < width; x++) {
                      const offset = buffer + y * stride + x * 4
                      solid =
                        e.m.HEAPU8[offset] === blue &&
                        e.m.HEAPU8[offset + 1] === green &&
                        e.m.HEAPU8[offset + 2] === red &&
                        e.m.HEAPU8[offset + 3] === alpha
                    }
                  if (solid) {
                    underlines.push({ label, mark })
                    preservedGraphics.push(mark.i)
                  }
                }
              }
            } finally {
              if (bitmap) p.FPDFBitmap_Destroy(bitmap)
              e.free(at)
            }
          }
        }
        if (overlapsGraphic(page, objects, fragment, sourceRect, preservedGraphics, sourceInk)) {
          // Renderer reflow can borrow blank space beyond the source text. Give
          // that space back when a figure paints there, retaining every owned
          // glyph and requiring a fresh paint check for the smaller region.
          const ink = {
            left: Math.min(...selected.map((o) => o.bounds[0])) - 0.1,
            right: Math.max(...selected.map((o) => o.bounds[2])) + 0.1,
            bottom: Math.min(...selected.map((o) => o.bounds[1])) - 0.1,
            top: Math.max(...selected.map((o) => o.bounds[3])) + 0.1
          }
          const candidates = [
            { ...sourceRect, bottom: Math.max(sourceRect.bottom, ink.bottom) },
            { ...sourceRect, top: Math.min(sourceRect.top, ink.top) },
            { ...sourceRect, width: Math.min(sourceRect.width, ink.right - sourceRect.x) },
            {
              ...sourceRect,
              x: Math.max(sourceRect.x, ink.left),
              width: sourceRect.x + sourceRect.width - Math.max(sourceRect.x, ink.left)
            }
          ]
            .filter((rect) => rect.width > 0 && rect.top > rect.bottom)
            .sort((a, b) => b.width * (b.top - b.bottom) - a.width * (a.top - a.bottom))
          const safe = candidates.find(
            (rect) => !overlapsGraphic(page, objects, fragment, rect, preservedGraphics, sourceInk)
          )
          check(safe)
          Object.assign(sourceRect, safe, { height: safe.top - safe.bottom })
        }
        const alignment = objectSourceOffsets(
          unit.source.slice(sourceCursor),
          matchingObjects,
          origin.verifiedHyphens(sourceRect),
          index < unit.fragments.length - 1,
          true,
          index < unit.fragments.length - 1
        )
        const offsets = new Map(
            [...alignment.offsets].map(([key, value]) => [key, value + sourceCursor])
          ),
          sourceOnlyOffsets = new Map(
            [...alignment.extraOffsets].map(([key, value]) => [key, value + sourceCursor])
          )
        sourceCursor += alignment.endOffset
        const region = {
          fragment,
          rect: sourceRect,
          source: selected.map((o) => o.text).join(''),
          sourceVerification: leadingObjectPrefixes.size
            ? matchingObjects.map((o) => o.text).join('')
            : undefined,
          sourceVerificationPrefix: [...leadingObjectPrefixes.values()].join(''),
          matchingSource: matchingObjects
            .filter((o) => !alignment.extraOffsets.has(o.i))
            .map((o) => (alignment.typographicHyphens?.has(o.i) ? '-' : o.text))
            .join('')
            .replace(/-\s*$/u, (suffix) => (alignment.trimmedEndHyphen ? '' : suffix)),
          sourceOnlyIndices: sourceOnlyOffsets,
          // Keep the original empty formatting run and its font/position. It is
          // excluded only from matching against PDF.js's visible source text.
          zeroInkIndices: selected
            .filter(
              (o) => zeroInkPositioningMarkers.has(o.i) && /^\u200c{1,8}$/u.test(o.text.trim())
            )
            .map((o) => o.i),
          sourceInk,
          sourceInkBoxes: sourceInk
            ? occupiedSource.map((box) => boundsBetween(box.slice(0, 2), box.slice(2)))
            : undefined,
          anchors: [],
          prose: [],
          baselines: [],
          unchanged
        }
        regions.push(region)
        if (sourceOnlyOffsets.size) {
          const targetOffsetFor = (sourceOffset) => {
            const candidates = selected
              .filter((object) => offsets.has(object.i) && !sourceOnlyOffsets.has(object.i))
              .map((object) => ({
                sourceOffset: offsets.get(object.i),
                label: object.text.trim()
              }))
              .filter((candidate) => candidate.label)
              .sort((a, b) => a.sourceOffset - b.sourceOffset)
            const next = candidates.find((candidate) => candidate.sourceOffset >= sourceOffset)
            if (next) {
              const target = inlineTargetOffset(
                unit.source,
                unit.translation,
                next.label,
                next.sourceOffset,
                /^\d+$/u.test(next.label)
              )
              if (target >= 0) return target
            }
            const previous = candidates.findLast(
              (candidate) => candidate.sourceOffset < sourceOffset
            )
            if (previous) {
              const target = inlineTargetOffset(
                unit.source,
                unit.translation,
                previous.label,
                previous.sourceOffset,
                /^\d+$/u.test(previous.label)
              )
              if (target >= 0) return target + previous.label.length
            }
            return -1
          }
          for (const [index, sourceOffset] of sourceOnlyOffsets) {
            const object = selected.find((candidate) => candidate.i === index),
              targetOffset = targetOffsetFor(sourceOffset)
            check(object && targetOffset >= 0, 'source-mismatch')
            region.anchors.push({
              mathGroup: true,
              sourceOnly: true,
              indices: [index],
              sourceOffset,
              targetOffset,
              label: '',
              baseline: objectBaselines.get(index),
              link: {
                left: object.bounds[0],
                bottom: object.bounds[1],
                right: object.bounds[2],
                top: object.bounds[3]
              }
            })
          }
        }
        // Keep unique inline labels at their original positions. Only complete
        // objects are retained even when a link covers only part of their glyphs.
        // Their entire label must survive verbatim; no text object is split.
        for (const link of origin.links) {
          if (
            link.right === link.left ||
            link.top === link.bottom ||
            link.right <= sourceRect.x ||
            link.left >= sourceRect.x + sourceRect.width ||
            link.top <= sourceRect.bottom ||
            link.bottom >= sourceRect.top
          )
            continue
          if (
            link.wholeRegion &&
            link.left <= sourceRect.x &&
            link.right >= sourceRect.x + sourceRect.width &&
            link.bottom <= sourceRect.bottom &&
            link.top >= sourceRect.top
          )
            continue
          check(link.wholeRegion, 'annotations')
          const intersectsLinkLine = (o) => {
            if (
              o.bounds[0] >= link.right ||
              o.bounds[2] <= link.left ||
              o.bounds[1] >= link.top ||
              o.bounds[3] <= link.bottom
            )
              return false
            // Publisher hit areas may touch the ink edge of a neighboring line.
            // Select the ink center perpendicular to the object's writing axis;
            // a link may still cover only part of the label along that axis.
            const at = e.alloc(24)
            try {
              check(p.FPDFPageObj_GetMatrix(o.obj, at))
              const [a, b] = e.m.HEAPF32.slice(at / 4, at / 4 + 2)
              return Math.abs(a) >= Math.abs(b)
                ? (o.bounds[1] + o.bounds[3]) / 2 > link.bottom &&
                    (o.bounds[1] + o.bounds[3]) / 2 < link.top
                : (o.bounds[0] + o.bounds[2]) / 2 > link.left &&
                    (o.bounds[0] + o.bounds[2]) / 2 < link.right
            } finally {
              e.free(at)
            }
          }
          const intersecting = selected.filter(intersectsLinkLine)
          const centered = intersecting.filter(
            (o) =>
              (o.bounds[0] + o.bounds[2]) / 2 > link.left &&
              (o.bounds[0] + o.bounds[2]) / 2 < link.right &&
              (o.bounds[1] + o.bounds[3]) / 2 > link.bottom &&
              (o.bounds[1] + o.bounds[3]) / 2 < link.top
          )
          const anchor = centered.length ? centered : intersecting
          if (
            !anchor.length &&
            unit.fragments.some((other) => {
              if (other === fragment || other.pageNumber !== fragment.pageNumber) return false
              const box = fragmentBounds(other),
                x = (link.left + link.right) / 2,
                y = (link.bottom + link.top) / 2
              return x >= box.x && x <= box.x + box.width && y >= box.bottom && y <= box.top
            })
          )
            continue
          if (!anchor.length) {
            const neighboring = objects.filter(
              (object) => object.type === 1 && intersectsLinkLine(object)
            )
            if (
              neighboring.length &&
              neighboring.every(
                (object) =>
                  object.bounds[0] >= sourceRect.x + sourceRect.width ||
                  object.bounds[2] <= sourceRect.x ||
                  object.bounds[1] >= sourceRect.top ||
                  object.bounds[3] <= sourceRect.bottom
              )
            )
              continue
          }
          check(anchor.length, 'annotations')
          const rawLabel = anchor
            .map((o) =>
              latinAccents.some(
                (accent) =>
                  accent.indices.includes(o.i) &&
                  accent.indices.every((i) => anchor.some((part) => part.i === i))
              )
                ? latinText.get(o.i)
                : o.text
            )
            .join('')
          let sourceLabel = rawLabel.trim(),
            sourceOffset = offsets.get(anchor[0].i) ?? unit.source.indexOf(rawLabel),
            partial = false
          if (!offsets.has(anchor[0].i))
            sourceOffset += rawLabel.length - rawLabel.trimStart().length
          // Locate the linked characters inside their actual native object. The
          // same label can occur twice on one line; string uniqueness is not a
          // substitute for the annotation's glyph coordinates.
          if (
            (/\p{L}/u.test(sourceLabel) || /^\[\d{1,3}\][).,:;]+$/u.test(sourceLabel)) &&
            anchor.some((o) => o.bounds[0] < link.left - 1 || o.bounds[2] > link.right + 1)
          ) {
            const text = p.FPDFText_LoadPage(page)
            check(text, 'annotations')
            const at = e.alloc(32)
            try {
              const count = p.FPDFText_CountChars(text),
                positions = new Map()
              let offset = 0,
                first = Infinity,
                last = -1
              for (const object of anchor) {
                positions.set(object.obj, { text: object.text, offset, cursor: 0 })
                offset += object.text.length
              }
              check(count >= 0 && count <= 100000, 'annotations')
              for (let index = 0; index < count; index++) {
                const code = p.FPDFText_GetUnicode(text, index),
                  position = positions.get(p.FPDFText_GetTextObject(text, index))
                if (!code || code === 10 || code === 13 || !position) continue
                const char = String.fromCodePoint(code),
                  local = position.text.indexOf(char, position.cursor)
                if (local < 0) continue
                position.cursor = local + char.length
                if (!p.FPDFText_GetCharBox(text, index, at, at + 8, at + 16, at + 24)) continue
                const [left, right, bottom, top] = e.m.HEAPF64.slice(at / 8, at / 8 + 4)
                if (![left, right, bottom, top].every(Number.isFinite)) continue
                const x = (left + right) / 2,
                  y = (bottom + top) / 2
                if (x >= link.left && x <= link.right && y >= link.bottom && y <= link.top) {
                  first = Math.min(first, position.offset + local)
                  last = Math.max(last, position.offset + local + char.length)
                }
              }
              const label = rawLabel.slice(first, last).trim(),
                start =
                  first +
                  rawLabel.slice(first, last).length -
                  rawLabel.slice(first, last).trimStart().length,
                trimmedStart = rawLabel.length - rawLabel.trimStart().length
              if (label && label.length <= 512 && label !== sourceLabel) {
                sourceOffset += start - trimmedStart
                sourceLabel = label
                partial = true
              }
            } finally {
              e.free(at)
              p.FPDFText_ClosePage(text)
            }
          }
          let localized, nativeUriTail
          if (sourceLabel.endsWith('\u0002') && origin.verifiedHyphens(sourceRect)) {
            const clean = sourceLabel.slice(0, -1),
              mapped = translatedPdfLinkFragment(unit.source, unit.translation, clean, sourceOffset)
            if (mapped) {
              sourceLabel = clean
              partial = true
              localized = mapped
            }
          }
          if (
            link.uri &&
            sourceLabel.startsWith(link.uri) &&
            /^[).,;:]+$/u.test(sourceLabel.slice(link.uri.length))
          ) {
            sourceLabel = link.uri
            partial = true
          }
          // A wrapped URI's last native object can also include the sentence
          // stop. Prove the complete address against its original link action
          // before separating that punctuation from this final URI segment.
          if (link.uri && /[.,;:]+$/u.test(sourceLabel)) {
            const clean = sourceLabel.replace(/[.,;:]+$/u, ''),
              address = pdfLinkAddressMatches(unit.source).find(
                (value) =>
                  value.text.replace(/ /gu, '') === link.uri &&
                  sourceOffset >= value.index &&
                  sourceOffset + clean.length === value.index + value.text.length
              ),
              mapped =
                address &&
                translatedPdfLinkFragment(unit.source, unit.translation, clean, sourceOffset)
            if (mapped) {
              sourceLabel = clean
              partial = true
              localized = mapped
              nativeUriTail = true
            }
          }
          // Some publishers include the surrounding closing parenthesis in
          // the URI hit area (and even in its action). Localize that punctuation
          // independently while preserving the original action verbatim.
          if (
            /^https?:\/\//u.test(sourceLabel) &&
            sourceLabel.endsWith(')') &&
            unit.source[sourceOffset - 1] === '('
          ) {
            const url = sourceLabel.slice(0, -1),
              target = inlineTargetOffset(unit.source, unit.translation, url, sourceOffset)
            if (target >= 0 && unit.translation[target + url.length] === '）') {
              sourceLabel = url
              partial = true
            }
          }
          // Keep the existing equal-length normalization for partial links;
          // their glyph-selected offsets cannot admit inserted/deleted spaces.
          if (
            offsets.has(anchor[0].i) &&
            sourceOffset >= 0 &&
            /[\u00a0\u202f]/u.test(sourceLabel)
          ) {
            const savedLabel = unit.source.slice(sourceOffset, sourceOffset + sourceLabel.length)
            if (sourceLabel.replace(/[\u00a0\u202f]/gu, ' ') === savedLabel)
              sourceLabel = savedLabel
          }
          // PDF engines may insert different spaces between native reference
          // objects, including a separately painted accent and its letter.
          // Recover only the exact span at its proven object offset; all visible
          // characters must still match and partial-object links stay conservative.
          // Explicit nonbreaking spaces must pass the equal-length check above.
          if (
            !partial &&
            !/[\u00a0\u202f]/u.test(sourceLabel) &&
            offsets.has(anchor[0].i) &&
            sourceOffset >= 0 &&
            unit.source.slice(sourceOffset, sourceOffset + sourceLabel.length) !== sourceLabel
          ) {
            const aligned = objectSourceOffsets(
                unit.source.slice(sourceOffset),
                [{ i: 0, text: sourceLabel }],
                false,
                true
              ),
              savedLabel = unit.source
                .slice(sourceOffset, sourceOffset + aligned.endOffset)
                .trimEnd()
            if (savedLabel && sourceLabel.replace(/\s/gu, '') === savedLabel.replace(/\s/gu, ''))
              sourceLabel = savedLabel
          }
          // Once a native number belongs to a complete closed citation, its
          // ordered list identity must survive; a unique bare numeral elsewhere
          // in the translation cannot substitute for a rejected citation.
          const bracketed = translatedPdfBracketedReference(
            unit.source,
            unit.translation,
            sourceLabel,
            sourceOffset
          )
          if (bracketed !== undefined) check(bracketed, 'annotations')
          localized ??=
            translatedPdfLinkLabel(unit.source, unit.translation, sourceLabel, sourceOffset) ??
            translatedPdfLinkFragment(unit.source, unit.translation, sourceLabel, sourceOffset)
          // Reuse a localized superscript only with a raised native footnote.
          // The post-sentence digit spelling additionally requires this proof;
          // ordinary linked labels retain their existing regeneration path.
          const unicodeDigit =
            localized &&
            /^[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/u.test(localized.text) &&
            /^\d{1,3}$/u.test(sourceLabel) &&
            localized.text.normalize('NFKC') === sourceLabel
          const unicodeFootnote =
            unicodeDigit &&
            anchor.length === 1 &&
            sizes.get(anchor[0].i) < bodySize * 0.85 &&
            selected.some(
              (object) =>
                sizes.get(object.i) >= bodySize * 0.9 &&
                objectBaselines.get(anchor[0].i) - objectBaselines.get(object.i) > bodySize * 0.2 &&
                objectBaselines.get(anchor[0].i) - objectBaselines.get(object.i) < bodySize * 0.7 &&
                anchor[0].bounds[0] - object.bounds[2] >= -bodySize * 0.1 &&
                anchor[0].bounds[0] - object.bounds[2] < bodySize * 2
            )
          if (unicodeDigit && unit.source[sourceOffset - 1] === '.')
            check(unicodeFootnote, 'annotations')
          // Linked fragments with proven complete citation/caption context must
          // retain that identity; an unchanged fragment alone is insufficient.
          if (
            (/^(?:[a-z]|\d{1,4}[.．。])$/u.test(sourceLabel) || /^[[［]/u.test(sourceLabel)) &&
            translatedPdfLinkFragment(unit.source, unit.source, sourceLabel, sourceOffset)
          )
            check(localized, 'annotations')
          const label = localized?.text ?? sourceLabel,
            generated = partial || (label !== sourceLabel && !unicodeFootnote),
            targetOffset =
              localized?.start ??
              inlineTargetOffset(unit.source, unit.translation, label, sourceOffset)
          check(
            label &&
              !/[\p{C}]/u.test(label) &&
              sourceOffset >= 0 &&
              targetOffset >= 0 &&
              unit.source.slice(sourceOffset, sourceOffset + sourceLabel.length) === sourceLabel &&
              unit.translation.slice(targetOffset, targetOffset + label.length) === label,
            'annotations'
          )
          // Publishers may draw "1, 2" as one object with one link per number.
          // Move that unchanged object once, but retain every annotation/action.
          const shared = region.anchors.find(
            (retained) =>
              !generated &&
              /^\d+(?:,\s*\d+)+$/u.test(label) &&
              !retained.generated &&
              retained.sourceOffset === sourceOffset &&
              retained.targetOffset === targetOffset &&
              retained.label === label &&
              retained.indices.length === anchor.length &&
              anchor.every((object) => retained.indices.includes(object.i))
          )
          if (shared) {
            shared.additionalAnnotations ??= []
            shared.additionalAnnotations.push(link)
            const annotations = [shared.annotation, ...shared.additionalAnnotations]
            const bounds = {
              left: Math.min(...annotations.map((item) => item.left)),
              right: Math.max(...annotations.map((item) => item.right)),
              bottom: Math.min(...annotations.map((item) => item.bottom)),
              top: Math.max(...annotations.map((item) => item.top))
            }
            shared.link = {
              left: Math.min(shared.link.left, link.left),
              right: Math.max(shared.link.right, link.right),
              bottom: Math.min(shared.link.bottom, link.bottom),
              top: Math.max(shared.link.top, link.top)
            }
            shared.movable = anchor.every(
              (object) =>
                object.bounds[0] >= bounds.left - 0.01 &&
                object.bounds[2] <= bounds.right + 0.01 &&
                object.bounds[1] >= bounds.bottom - 0.01 &&
                object.bounds[3] <= bounds.top + 0.01
            )
            continue
          }
          check(
            region.anchors.every((retained) =>
              retained.indices.every((i) => !anchor.some((o) => o.i === i))
            ),
            'annotations'
          )
          const overhang =
            link.bottom < sourceRect.bottom - objectTolerance ||
            link.top > sourceRect.top + objectTolerance
          if (overhang)
            check(
              link.left >= sourceRect.x - objectTolerance &&
                link.right <= sourceRect.x + sourceRect.width + objectTolerance &&
                (((link.bottom + link.top) / 2 >= sourceRect.bottom &&
                  (link.bottom + link.top) / 2 <= sourceRect.top) ||
                  anchor.every(
                    (object) =>
                      object.bounds[1] >= sourceRect.bottom - 0.01 &&
                      object.bounds[3] <= sourceRect.top + 0.01
                  )),
              'annotations'
            )
          region.anchors.push({
            annotation: link,
            ...(overhang
              ? { overhang: objects.filter((o) => !selected.includes(o)).map((o) => o.bounds) }
              : {}),
            generated,
            nativeUriTail,
            glyphBounds: {
              left: Math.min(...anchor.map((o) => o.bounds[0])),
              bottom: Math.min(...anchor.map((o) => o.bounds[1])),
              right: Math.max(...anchor.map((o) => o.bounds[2])),
              top: Math.max(...anchor.map((o) => o.bounds[3]))
            },
            sourceLabel,
            nativeAccentIndices: latinAccents
              .filter((accent) => accent.indices.every((i) => anchor.some((part) => part.i === i)))
              .map((accent) => accent.accentIndex),
            scale: 1,
            // Reserve retained glyph ink as well as the unchanged clickable rectangle.
            link: {
              left: partial ? link.left : Math.min(link.left, ...anchor.map((o) => o.bounds[0])),
              bottom: partial
                ? link.bottom
                : Math.min(link.bottom, ...anchor.map((o) => o.bounds[1])),
              right: partial ? link.right : Math.max(link.right, ...anchor.map((o) => o.bounds[2])),
              top: partial ? link.top : Math.max(link.top, ...anchor.map((o) => o.bounds[3]))
            },
            indices: partial ? [] : anchor.map((o) => o.i),
            ...(partial ? { sourceIndices: anchor.map((o) => o.i) } : {}),
            sourceOffset,
            targetOffset,
            label,
            movable:
              partial ||
              // Regeneration owns the complete label, including punctuation
              // outside the original hit area; its reserved link box above
              // includes that ink and still passes final moved-link checks.
              (generated &&
                sourceLabel ===
                  anchor
                    .map((object) => object.text)
                    .join('')
                    .trim()) ||
              anchor.every(
                (o) =>
                  o.bounds[0] >= link.left - objectTolerance &&
                  o.bounds[2] <= link.right + objectTolerance &&
                  // Publisher hit boxes can omit punctuation/descenders. The union
                  // above reserves their ink; move glyphs and hit box together.
                  o.bounds[1] >= link.bottom - objectTolerance &&
                  o.bounds[3] <= link.top + objectTolerance
              )
          })
        }
        for (const { label: object, mark } of underlines) {
          const label = object.text.trim(),
            sourceOffset = offsets.get(object.i),
            targetOffset = 0
          check(
            sourceOffset === 0 &&
              unit.source.startsWith(label + ':') &&
              unit.translation.startsWith(label) &&
              /^[:：]/u.test(unit.translation.slice(label.length)) &&
              !region.anchors.some((anchor) => anchor.indices.includes(object.i)),
            'unsupported-layout'
          )
          region.anchors.push({
            mathGroup: true,
            indices: [object.i, mark.i],
            textIndices: [object.i],
            graphicIndices: [mark.i],
            sourceOffset,
            targetOffset,
            label,
            baseline: objectBaselines.get(object.i),
            link: {
              left: Math.min(object.bounds[0], mark.bounds[0]),
              bottom: Math.min(object.bounds[1], mark.bounds[1]),
              right: Math.max(object.bounds[2], mark.bounds[2]),
              top: Math.max(object.bounds[3], mark.bounds[3])
            }
          })
        }
        // Synthetic bold overprints are one visible label. Keep every proven
        // native copy together instead of laying out its repeated source letters.
        for (const group of overprintGroups) {
          const members = group.objects.map((obj) => selected.find((o) => o.obj === obj))
          if (!members.some(Boolean)) continue
          check(members.every(Boolean), 'annotations')
          const indices = members.map((o) => o.i)
          if (region.anchors.some((anchor) => indices.every((i) => anchor.indices.includes(i))))
            continue
          check(
            !region.anchors.some((anchor) => indices.some((i) => anchor.indices.includes(i))),
            'annotations'
          )
          const sourceOffset = offsets.get(indices[0]),
            lastOffset = offsets.get(indices.at(-1)),
            label = unit.source.slice(sourceOffset, lastOffset + members.at(-1).text.trim().length),
            targetOffset = inlineTargetOffset(
              unit.source,
              unit.translation,
              label,
              sourceOffset,
              true
            )
          check(
            sourceOffset !== undefined &&
              lastOffset !== undefined &&
              sourceMatches(group.labelSource, label) &&
              targetOffset >= 0 &&
              unit.translation.slice(targetOffset, targetOffset + label.length) === label,
            'annotations'
          )
          region.anchors.push({
            mathGroup: true,
            indices,
            sourceOffset,
            targetOffset,
            label,
            baseline: objectBaselines.get(indices[0]),
            link: {
              left: Math.min(...members.map((o) => o.bounds[0])),
              bottom: Math.min(...members.map((o) => o.bounds[1])),
              right: Math.max(...members.map((o) => o.bounds[2])),
              top: Math.max(...members.map((o) => o.bounds[3]))
            }
          })
        }
        // Superscript references and scientific subscripts are original inline
        // glyphs, not a reason to leave the surrounding translated prose untouched.
        for (const accent of [...accents, ...fractions, ...radicals]) {
          const sourceOffset = offsets.get((accent.textIndices ?? accent.indices)[0]),
            label = accent.label,
            occurrences = (text) => [
              ...text.matchAll(
                new RegExp(
                  [...sourceGraphemes.segment(label.replace(/\s/gu, ''))]
                    .map(
                      ({ segment }) =>
                        '(?:' +
                        [...new Set([segment.normalize('NFC'), segment.normalize('NFD')])]
                          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                          .join('|') +
                        ')'
                    )
                    .join('\\s*') +
                    (accent.radical
                      ? "(?![\\p{Script=Latin}\\p{Script=Greek}\\p{N}\\p{M}_′″‴'\\u{1D400}-\\u{1D7FF}])"
                      : ''),
                  'gu'
                )
              )
            ],
            from = occurrences(unit.source),
            to = occurrences(unit.translation),
            occurrence = from.findIndex((match) => match.index === sourceOffset)
          if (accent.radical)
            check(
              occurrence >= 0 &&
                from.length === to.length &&
                region.anchors.every(
                  (anchor) => !anchor.indices.some((i) => accent.indices.includes(i))
                ),
              'unsupported-layout'
            )
          if (occurrence < 0 || from.length !== to.length) continue
          region.anchors.push({
            mathGroup: true,
            indices: accent.indices,
            textIndices: accent.textIndices ?? accent.indices,
            graphicIndices: accent.graphicIndices ?? [],
            sourceOffset,
            targetOffset: to[occurrence].index,
            label: to[occurrence][0],
            sourceLabel: from[occurrence][0],
            baseline:
              accent.baseline ?? Math.min(...accent.indices.map((i) => objectBaselines.get(i))),
            link: {
              left: accent.bounds[0],
              bottom: accent.bounds[1],
              right: accent.bounds[2],
              top: accent.bounds[3]
            }
          })
        }
        const markers = selected
          .filter((o) => !region.anchors.some((a) => a.indices.includes(o.i)))
          .map((o) => {
            const baseline = objectBaselines.get(o.i)
            const closest = bodyBaselines.reduce(
              (nearest, y) => (Math.abs(y - baseline) < Math.abs(nearest - baseline) ? y : nearest),
              bodyBaselines[0]
            )
            return {
              sourceOffset: offsets.get(o.i),
              label: o.text.trim(),
              scale: sizes.get(o.i) / bodySize,
              rise: baseline - closest,
              bounds: [...o.bounds],
              sourceIndices: [o.i]
            }
          })
        // Geometry-proven exponents are explicit in the admitted source (10⁵).
        // A translation may spell out the equivalent count, so those glyphs can
        // be replaced with the prose rather than requiring an unchanged "5".
        const explicitPowers = new Set(
          markers
            .filter((marker) => {
              const raised = unit.source.slice(
                marker.sourceOffset,
                marker.sourceOffset + marker.label.length
              )
              return (
                marker.scale < 0.9 &&
                marker.rise > bodySize * 0.2 &&
                /^[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2}$/u.test(raised) &&
                raised.normalize('NFKC') === marker.label &&
                /\d\s*[×·]\s*10$/u.test(unit.source.slice(0, marker.sourceOffset))
              )
            })
            .flatMap((marker) => marker.sourceIndices)
        )
        const powerIndices = new Set(
          resolveExplicitPowerIndices(unit.source, unit.translation, markers, bodySize)
        )
        const powers = (text) => [
          ...text.matchAll(
            /(?<![A-Za-z\p{Script=Greek}\d])\d{1,4}(⁻[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2})(?![A-Za-z\p{Script=Greek}\d⁻⁰¹²³⁴⁵⁶⁷⁸⁹])/gu
          )
        ]
        for (const power of powers(unit.source)) {
          const from = powers(unit.source).filter((match) => match[0] === power[0]),
            to = powers(unit.translation).filter((match) => match[0] === power[0]),
            start = power.index + power[0].length - power[1].length,
            bases = markers.filter(
              (marker) =>
                marker.sourceOffset <= power.index &&
                marker.sourceOffset + marker.label.length === start &&
                marker.scale >= 0.9 &&
                Math.abs(marker.rise) < 0.01 &&
                unit.source.slice(marker.sourceOffset, start) === marker.label
            ),
            base = bases[0],
            parts = markers.filter(
              (marker) =>
                marker.sourceOffset >= start && marker.sourceOffset < power.index + power[0].length
            )
          if (
            bases.length !== 1 ||
            !parts.length ||
            from.length !== to.length ||
            !parts.every((marker) => marker.sourceIndices.every((i) => powerIndices.has(i)))
          )
            continue
          // The decimal base can end a fully owned prose object. Its body text
          // is regenerated; retain only the complete, geometry-proven exponent
          // beside that generated base, without copying the shared prose run.
          const scriptOnly = base.sourceOffset < power.index,
            indices = (scriptOnly ? parts : [base, ...parts]).flatMap(
              (marker) => marker.sourceIndices
            ),
            objects = selected.filter((object) => indices.includes(object.i)),
            target = to[from.findIndex((match) => match.index === power.index)]
          region.anchors.push({
            mathGroup: true,
            indices,
            sourceOffset: scriptOnly ? start : power.index,
            targetOffset: target.index + (scriptOnly ? power[0].length - power[1].length : 0),
            label: scriptOnly ? power[1] : power[0],
            scriptOnlyPower: scriptOnly,
            baseline: objectBaselines.get(base.sourceIndices[0]),
            link: {
              left: Math.min(...objects.map((object) => object.bounds[0])),
              bottom: Math.min(...objects.map((object) => object.bounds[1])),
              right: Math.max(...objects.map((object) => object.bounds[2])),
              top: Math.max(...objects.map((object) => object.bounds[3]))
            }
          })
          for (const i of indices) powerIndices.delete(i)
        }
        for (const index of powerIndices) explicitPowers.add(index)
        if (unit.translation !== unit.source)
          for (const index of resolveOrdinalSuffixIndices(unit.source, markers, bodySize))
            explicitPowers.add(index)
        for (const index of resolveExplicitTransposeIndices(unit.source, unit.translation, markers))
          explicitPowers.add(index)
        for (const group of resolveNestedScriptGroups(unit.source, unit.translation, markers)) {
          const objects = selected.filter((object) => group.sourceIndices.includes(object.i))
          region.anchors.push({
            mathGroup: true,
            indices: group.sourceIndices,
            sourceOffset: group.sourceOffset,
            targetOffset: group.targetOffset,
            label: group.label,
            baseline: objectBaselines.get(group.baselineIndex ?? group.sourceIndices[0]),
            link: {
              left: Math.min(...objects.map((object) => object.bounds[0])),
              bottom: Math.min(...objects.map((object) => object.bounds[1])),
              right: Math.max(...objects.map((object) => object.bounds[2])),
              top: Math.max(...objects.map((object) => object.bounds[3]))
            }
          })
        }
        // Two successive lowered levels cannot be represented by the flat
        // generated-script fallback. Keep the source unless a native group owns
        // the complete chain, including objects already claimed by an anchor.
        if (horizontalSource)
          for (let index = 0; index + 2 < selected.length; index++) {
            const chain = selected.slice(index, index + 3),
              [base, lower, inner] = chain,
              labels = chain.map((object) => object.text.trim()),
              start = offsets.get(base.i),
              label = labels.join(''),
              points = chain.map((object) => sizes.get(object.i)),
              baselines = chain.map((object) => objectBaselines.get(object.i)),
              boundary = /[\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'<>≤≥\u{1d400}-\u{1d7ff}]/u
            if (
              !/^[A-Za-z\p{Script=Greek}]$/u.test(labels[0]) ||
              !/^[A-Za-z\p{Script=Greek}\d]$/u.test(labels[1]) ||
              !/^[<>≤≥]?[A-Za-z\p{Script=Greek}\d]$/u.test(labels[2]) ||
              !Number.isInteger(start) ||
              start < 0 ||
              offsets.get(lower.i) !== start + labels[0].length ||
              offsets.get(inner.i) !== start + labels[0].length + labels[1].length ||
              unit.source.slice(start, start + label.length) !== label ||
              boundary.test([...unit.source.slice(0, start)].at(-1) ?? '') ||
              boundary.test([...unit.source.slice(start + label.length)][0] ?? '') ||
              lower.i !== base.i + 1 ||
              inner.i !== lower.i + 1 ||
              ![...points, ...baselines].every(Number.isFinite) ||
              points[0] < bodySize * 0.9 ||
              points[0] > bodySize * 1.1 ||
              !chain.every(
                (object) =>
                  object.bounds.length === 4 &&
                  object.bounds.every(Number.isFinite) &&
                  object.bounds[0] < object.bounds[2] &&
                  object.bounds[1] < object.bounds[3]
              ) ||
              ![1, 2].every((part) => {
                const previous = chain[part - 1],
                  current = chain[part],
                  drop = baselines[part - 1] - baselines[part],
                  point = points[part - 1]
                return (
                  points[part] >= point * 0.5 &&
                  points[part] < point * 0.85 &&
                  drop >= point * 0.05 &&
                  drop <= point * 0.35 &&
                  current.bounds[0] > previous.bounds[0] &&
                  current.bounds[0] >= previous.bounds[2] - point * 0.2 &&
                  current.bounds[0] <= previous.bounds[2] + point * 0.3 &&
                  current.bounds[3] > previous.bounds[1]
                )
              })
            )
              continue
            check(
              region.anchors.some(
                (anchor) =>
                  anchor.mathGroup &&
                  !anchor.generated &&
                  chain.every((object) => anchor.indices.includes(object.i))
              ),
              'unsupported-layout'
            )
          }
        // A proven paired native stack must not degrade to flat prose when
        // the target changes its token or occurrence count.
        for (const group of resolveNestedScriptGroups(unit.source, unit.source, markers)) {
          if (
            group.scriptOnly ||
            (group.baselineIndex === group.sourceIndices[0] &&
              ((group.sourceIndices.length === 3 &&
                /^[A-Za-z\p{Script=Greek}][A-Za-z\p{Script=Greek}\d]{2,7}$/u.test(group.label)) ||
                (group.sourceIndices.length === 2 &&
                  /^[A-Za-z\p{Script=Greek}][+−]$/u.test(group.label))))
          )
            check(
              region.anchors.some(
                (anchor) =>
                  anchor.mathGroup &&
                  !anchor.generated &&
                  anchor.sourceOffset === group.sourceOffset &&
                  anchor.indices.length === group.sourceIndices.length &&
                  group.sourceIndices.every((index) => anchor.indices.includes(index))
              ),
              'unsupported-layout'
            )
        }
        for (const span of resolveScientificScriptSpans(
          unit.source,
          unit.translation,
          markers.filter(
            (marker) =>
              !region.anchors.some((anchor) =>
                marker.sourceIndices.some((index) => anchor.indices.includes(index))
              )
          )
        )) {
          const original = selected.find((o) => o.i === span.sourceIndices[0])
          region.anchors.push({
            generated: true,
            scale: span.scale,
            scriptRise: span.rise,
            link: {
              left: original.bounds[0],
              bottom: original.bounds[1],
              right: original.bounds[2],
              top: original.bounds[3]
            },
            indices: span.sourceIndices,
            sourceOffset: span.sourceOffsets[0],
            targetOffset: span.start,
            label: unit.translation.slice(span.start, span.end),
            baseline: objectBaselines.get(original.i),
            movable: true
          })
        }
        // Translated academic degrees no longer share the source's identifier
        // (PhD2). Map the complete author-footnote sequence only when native
        // geometry proves every marker and the target keeps every label in order.
        const authorFootnotes = markers.filter(
          (marker) =>
            marker.scale < 0.9 &&
            marker.rise > bodySize * 0.2 &&
            /^\d{1,2}[*†‡]?$/u.test(marker.label) &&
            /\b(?:MM|MD|PhD|MSc|BSc)$/u.test(unit.source.slice(0, marker.sourceOffset))
        )
        const translatedFootnotes = [...unit.translation.matchAll(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+[*†‡]?/gu)]
        if (
          authorFootnotes.length >= 2 &&
          authorFootnotes.length === translatedFootnotes.length &&
          authorFootnotes.every(
            (marker, index) => translatedFootnotes[index][0].normalize('NFKC') === marker.label
          )
        ) {
          for (const [index, marker] of authorFootnotes.entries()) {
            if (region.anchors.some((anchor) => anchor.indices.includes(marker.sourceIndices[0])))
              continue
            const object = selected.find((value) => value.i === marker.sourceIndices[0])
            region.anchors.push({
              link: {
                left: object.bounds[0],
                bottom: object.bounds[1],
                right: object.bounds[2],
                top: object.bounds[3]
              },
              indices: marker.sourceIndices,
              sourceOffset: marker.sourceOffset,
              targetOffset: translatedFootnotes[index].index,
              label: translatedFootnotes[index][0]
            })
          }
        }
        for (const object of selected) {
          const label = object.text.trim(),
            sourceOffset = offsets.get(object.i),
            marker = markers.find((value) => value.sourceIndices.includes(object.i)),
            nativeAlphabet = nativeMathAlphabet(object, nativeFontName(object)),
            // An owned math-font run may include an ellipsis/comma with its
            // letter. Keep the complete run only with exact target identity.
            mathematicalRun =
              /^[\u{1D400}-\u{1D7CB}\d., ()]+$/u.test(label) &&
              /[\u{1D400}-\u{1D7CB}]/u.test(label),
            loweredIndexOperator =
              /^[+−-](?:\d{1,2})?$/u.test(label) &&
              marker?.scale > 0.6 &&
              marker.scale < 0.9 &&
              marker.rise < -bodySize * 0.08 &&
              marker.rise > -bodySize * 0.4 &&
              /[\u{1D400}-\u{1D7CB}]$/u.test(unit.source.slice(0, sourceOffset)) &&
              /^(?:\d{1,2}|[\u{1D400}-\u{1D7CB}])/u.test(unit.source.slice(sourceOffset + 1)),
            // Legacy CMSY encodings can expose relation glyphs as control codes.
            // Preserve the complete, owned native object only with exact target
            // identity; never delete the control or guess its Unicode meaning.
            nativeEncodedSymbol =
              /^(?:[A-Z]{6}\+)?CMSY(?:5|6|7|8|9|10|12)$/u.test(nativeFontName(object)) &&
              /[^\P{Cc}\s]/u.test(label) &&
              /^[\p{Sm}\p{Cc}\s]+$/u.test(label) &&
              object.bounds[2] > object.bounds[0] &&
              object.bounds[3] > object.bounds[1],
            nativeSymbol =
              nativeAlphabet ||
              mathematicalRun ||
              loweredIndexOperator ||
              nativeEncodedSymbol ||
              registeredMarks.has(object.i) ||
              ((/^[\p{L}\p{Sm}\p{So}]$/u.test(label) ||
                /^[\p{Sm}]\s*[A-Za-z\p{Script=Greek}]$/u.test(label)) &&
                (!face.hasGlyphForCodePoint(label.codePointAt(0)) ||
                  // A raised standalone symbol keeps its original glyph even if
                  // the target font supports that Unicode code point. Its native
                  // font encoding and script position belong to the source PDF.
                  (/^[\p{Sm}\p{So}]$/u.test(label) &&
                    marker?.scale < 0.9 &&
                    marker.rise > bodySize * 0.2 &&
                    marker.rise < bodySize * 0.75)))
          if (
            (!nativeSymbol && sizes.get(object.i) >= bodySize * 0.9) ||
            region.anchors.some((anchor) => anchor.indices.includes(object.i))
          )
            continue
          if (
            sourceOffset === undefined ||
            (!nativeSymbol && !/^(?:[\d,.;:–−-]+|[*∗†‡#]+)$/u.test(label))
          )
            continue
          let targetOffset = inlineTargetOffset(
            unit.source,
            unit.translation,
            label,
            sourceOffset,
            /^\d+$/u.test(label)
          )
          if (registeredMarks.has(object.i)) {
            const brand = registeredMarks
                .get(object.i)
                .text.trim()
                .match(/[A-Za-z][A-Za-z0-9-]{1,39}$/u)[0],
              brandOffset = sourceOffset - brand.length,
              occurrences = (text) => [
                ...text.matchAll(new RegExp('(?<![A-Za-z0-9-])' + brand + '®', 'gu'))
              ],
              from = occurrences(unit.source),
              to = occurrences(unit.translation),
              occurrence = from.findIndex((match) => match.index === brandOffset)
            check(
              unit.source.slice(brandOffset, sourceOffset + 1) === brand + '®' &&
                occurrence >= 0 &&
                from.length === to.length,
              'annotations'
            )
            targetOffset = to[occurrence].index + brand.length
          }
          const completeSymbol = (text, offset) =>
            !/[A-Za-z\p{Script=Greek}]$/u.test(label) ||
            !/[A-Za-z\p{Script=Greek}]/u.test(text[offset + label.length] ?? '')
          if (nativeSymbol && targetOffset >= 0 && !completeSymbol(unit.translation, targetOffset))
            targetOffset = -1
          if (
            targetOffset < 0 &&
            nativeSymbol &&
            !(label === '∼' && /\d%?\s*∼\s*\d/u.test(unit.source))
          ) {
            // Identical unsupported relation signs can occur in several formulas.
            // Preserve complete native objects in source order only when every
            // exact occurrence survives; never substitute a different glyph.
            const occurrences = (text) => [
              ...text.matchAll(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu'))
            ]
            const from = occurrences(unit.source).filter((match) =>
                completeSymbol(unit.source, match.index)
              ),
              to = occurrences(unit.translation).filter((match) =>
                completeSymbol(unit.translation, match.index)
              )
            const occurrence = from.findIndex((match) => match.index === sourceOffset)
            if (occurrence >= 0 && from.length === to.length) targetOffset = to[occurrence].index
          }
          // Publisher-encoded glyphs require exact source identity. If the target
          // changes or ambiguously duplicates them, retain the verified paragraph.
          if (nativeAlphabet || nativeEncodedSymbol || mathematicalRun || loweredIndexOperator)
            check(
              targetOffset >= 0 &&
                (!nativeAlphabet ||
                  (!/[A-Za-z\p{Script=Greek}]/u.test(unit.source[sourceOffset - 1] ?? '') &&
                    !/[A-Za-z\p{Script=Greek}]/u.test(unit.translation[targetOffset - 1] ?? ''))),
              'annotations'
            )
          let targetLabel = label
          if (
            targetOffset < 0 &&
            /^\d{1,2}$/u.test(label) &&
            marker?.scale < 0.9 &&
            marker.rise > bodySize * 0.2
          ) {
            // Unicode superscript spelling may describe the same native raised
            // footnote. Normalize only digit glyphs so target offsets stay exact,
            // and retain the ordinary occurrence/identity ambiguity checks.
            const equivalent = unit.translation.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/gu, (digit) =>
                digit.normalize('NFKC')
              ),
              sourceEquivalent = unit.source.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/gu, (digit) =>
                digit.normalize('NFKC')
              )
            const raisedOffset = inlineTargetOffset(
              sourceEquivalent,
              equivalent,
              label,
              sourceOffset,
              true
            )
            const raised = unit.translation.slice(raisedOffset, raisedOffset + label.length)
            if (
              raisedOffset >= 0 &&
              /^[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/u.test(raised) &&
              raised.normalize('NFKC') === label
            ) {
              targetOffset = raisedOffset
              targetLabel = raised
            }
          }
          if (
            targetOffset < 0 ||
            unit.translation.slice(targetOffset, targetOffset + targetLabel.length) !== targetLabel
          )
            continue
          region.anchors.push({
            link: {
              left: object.bounds[0],
              bottom: object.bounds[1],
              right: object.bounds[2],
              top: object.bounds[3]
            },
            indices: [object.i],
            sourceOffset,
            targetOffset,
            label: targetLabel,
            registeredBrand: registeredMarks.has(object.i)
          })
        }
        // Retain only complete, position-matched objects in a verbatim unchanged
        // prefix/suffix. Keep each retained run on one source line.
        const matrix = e.alloc(24)
        let firstBaseline
        region.singleLine = true
        try {
          for (const o of region.anchors.length ? selected : []) {
            if (region.anchors.some((anchor) => anchor.indices.includes(o.i))) continue
            check(p.FPDFPageObj_GetMatrix(o.obj, matrix))
            const [a, b, , , x, y] = e.m.HEAPF32.slice(matrix / 4, matrix / 4 + 6),
              scale = Math.hypot(a, b),
              baseline = (-b * x + a * y) / scale
            o.baseline = baseline
            firstBaseline ??= baseline
            if (Math.abs(baseline - firstBaseline) >= 0.01) region.singleLine = false
          }
        } finally {
          e.free(matrix)
        }
        if (region.anchors.length) {
          let prefix = 0,
            suffix = 0
          while (
            prefix < Math.min(unit.source.length, unit.translation.length) &&
            unit.source[prefix] === unit.translation[prefix]
          )
            prefix++
          while (
            suffix < Math.min(unit.source.length, unit.translation.length) - prefix &&
            unit.source.at(-suffix - 1) === unit.translation.at(-suffix - 1)
          )
            suffix++
          const groups = []
          let group = [],
            cursor = 0,
            aligned = true
          for (const o of selected) {
            const label = o.text.trim(),
              sourceOffset = unit.source.indexOf(label, cursor)
            if (sourceOffset < 0 || unit.source.slice(cursor, sourceOffset).trim()) {
              aligned = false
              break
            }
            cursor = sourceOffset + label.length
            const targetOffset = sourceOffset + unit.translation.length - unit.source.length,
              retainedTargetOffset =
                sourceOffset + label.length <= prefix ? sourceOffset : targetOffset
            const keep =
              label.length > 0 &&
              !/[\p{C}]/u.test(label) &&
              !region.anchors.some((anchor) => anchor.indices.includes(o.i)) &&
              // A generated, complete supporting-file link already replaces its
              // literal S-number prefix. Keeping that native prefix separately
              // would give the same source/target span two overlapping anchors.
              !region.anchors.some(
                (anchor) =>
                  anchor.generated &&
                  anchor.sourceLabel &&
                  anchor.sourceIndices?.includes(o.i) &&
                  pdfLinkLabelKey(anchor.sourceLabel)?.startsWith('supplementary-file:') &&
                  pdfLinkLabelKey(anchor.sourceLabel) === pdfLinkLabelKey(anchor.label) &&
                  sourceOffset < anchor.sourceOffset + anchor.sourceLabel.length &&
                  sourceOffset + label.length > anchor.sourceOffset &&
                  retainedTargetOffset < anchor.targetOffset + anchor.label.length &&
                  retainedTargetOffset + label.length > anchor.targetOffset
              ) &&
              (sourceOffset + label.length <= prefix ||
                (sourceOffset >= unit.source.length - suffix &&
                  targetOffset >= 0 &&
                  unit.translation.slice(targetOffset, targetOffset + label.length) === label))
            if (keep && group.length && Math.abs(group.at(-1).baseline - o.baseline) >= 0.01) {
              groups.push(group)
              group = []
            }
            if (keep)
              group.push({
                ...o,
                sourceOffset,
                targetOffset: retainedTargetOffset
              })
            else if (group.length) {
              groups.push(group)
              group = []
            }
          }
          if (group.length) groups.push(group)
          if (
            !aligned ||
            unit.source.slice(cursor).trim() ||
            selected.every(
              (o) =>
                region.anchors.some((anchor) => anchor.indices.includes(o.i)) ||
                groups.some((objects) => objects.some((retained) => retained.i === o.i))
            )
          )
            groups.length = 0
          for (const objects of groups) {
            const label = objects
                .map((o) => o.text)
                .join('')
                .trim(),
              sourceOffset = objects[0].sourceOffset,
              targetOffset = objects[0].targetOffset
            if (
              unit.source.slice(sourceOffset, sourceOffset + label.length) !== label ||
              unit.translation.slice(targetOffset, targetOffset + label.length) !== label
            )
              continue
            region.anchors.push({
              link: {
                left: Math.min(...objects.map((o) => o.bounds[0])),
                bottom: Math.min(...objects.map((o) => o.bounds[1])),
                right: Math.max(...objects.map((o) => o.bounds[2])),
                top: Math.max(...objects.map((o) => o.bounds[3]))
              },
              indices: objects.map((o) => o.i),
              sourceOffset,
              targetOffset,
              label,
              prose: true
            })
          }
        }
        const completeLinkedRegion =
          region.anchors.length === 1 &&
          region.anchors[0].generated &&
          region.anchors[0].annotation &&
          region.anchors[0].sourceLabel === region.source.trim() &&
          unit.source.slice(
            region.anchors[0].sourceOffset,
            region.anchors[0].sourceOffset + region.anchors[0].sourceLabel.length
          ) === region.anchors[0].sourceLabel &&
          unit.translation.slice(
            region.anchors[0].targetOffset,
            region.anchors[0].targetOffset + region.anchors[0].label.length
          ) === region.anchors[0].label &&
          region.anchors[0].indices.length === selected.length &&
          selected.every((object) => region.anchors[0].indices.includes(object.i))
        const at = e.alloc(24)
        try {
          for (const o of selected) {
            // A clipped, zero-ink space can be a publisher's positioning object.
            // It owns no visible glyph and must not reject otherwise editable prose.
            if (!o.text.trim() && o.bounds[0] === o.bounds[2] && o.bounds[1] === o.bounds[3])
              continue
            check(p.FPDFPageObj_GetMatrix(o.obj, at))
            const [a, b, c, d, x, y] = e.m.HEAPF32.slice(at / 4, at / 4 + 6)
            const scale = Math.hypot(a, b),
              direction = Math.round(Math.atan2(b, a) / (Math.PI / 2)),
              u = Math.round(Math.cos((direction * Math.PI) / 2)),
              v = Math.round(Math.sin((direction * Math.PI) / 2)),
              verticalScale = -v * c + u * d,
              oblique = (u * c + v * d) / verticalScale
            // Synthetic italics shear glyphs along an unchanged baseline. Measure
            // font height perpendicular to it; retain quarter-turn axes and reject
            // reflections, tilted baselines and excessive shear.
            check(
              scale > 0 &&
                verticalScale > 0 &&
                Math.abs(a / scale - u) < 0.000001 &&
                Math.abs(b / scale - v) < 0.000001 &&
                Math.abs(oblique) <= 0.3 &&
                (cos === undefined || (cos === u && sin === v))
            )
            cos = u
            sin = v
            if (o === dropCap) {
              // A verbatim prefix may retain the initial as a native anchor.
              // Its decorative geometry never exempts its paint or clip proof.
              check(p.FPDFTextObj_GetTextRenderMode(o.obj) === 0)
              const clip = p.FPDFPageObj_GetClipPath(o.obj)
              check(clip && p.FPDFClipPath_CountPaths(clip) === -1)
            }
            for (const anchor of region.anchors) {
              if (anchor.sourceIndices?.includes(o.i)) anchor.baseline ??= -sin * x + cos * y
            }
            const retained = region.anchors.find((anchor) => anchor.indices.includes(o.i))
            if (retained?.generated && retained.baseline === undefined) {
              retained.baseline = -sin * x + cos * y
              // A full-size citation tail can be the only text on its source
              // row. Its missing prose neighbor must not turn it into a subscript.
              if (
                retained.annotation &&
                /^\d{4}[a-z]?[)）][.。]?$/u.test(retained.sourceLabel ?? '') &&
                sizes.get(o.i) >= bodySize * 0.9
              )
                retained.nativeRowBaseline = retained.baseline
            }
            if (retained && !retained.generated) {
              const baseline = -sin * x + cos * y,
                clip = p.FPDFPageObj_GetClipPath(o.obj)
              retained.baseline ??= baseline
              retained.origin = Math.min(retained.origin ?? Infinity, cos * x + sin * y)
              retained.movable =
                (retained.movable ?? true) &&
                (retained.mathGroup ||
                  retained.nativeAccentIndices?.includes(o.i) ||
                  // Preserve tiny publisher baseline adjustments while moving
                  // the native objects together; true scripts stay distinct.
                  Math.abs(retained.baseline - baseline) <= Math.min(0.1, bodySize * 0.01)) &&
                p.FPDFTextObj_GetTextRenderMode(o.obj) === 0 &&
                !!clip &&
                p.FPDFClipPath_CountPaths(clip) === -1
            }
            if (retained?.generated) {
              const clip = p.FPDFPageObj_GetClipPath(o.obj)
              check(
                p.FPDFTextObj_GetTextRenderMode(o.obj) === 0 &&
                  clip &&
                  p.FPDFClipPath_CountPaths(clip) === -1
              )
            }
            if (retained && !retained.prose && !completeLinkedRegion) continue
            if (o !== dropCap) sourceBaseline ??= -sin * x + cos * y
            const actualBaseline = -sin * x + cos * y,
              baseline = explicitPowers.has(o.i)
                ? bodyBaselines.reduce((nearest, value) =>
                    Math.abs(value - actualBaseline) < Math.abs(nearest - actualBaseline)
                      ? value
                      : nearest
                  )
                : actualBaseline
            if (
              o !== dropCap &&
              !region.baselines.some((value) => Math.abs(value - baseline) < 0.01)
            )
              region.baselines.push(baseline)
            if (
              region.anchors.some((anchor) => anchor.indices.includes(o.i)) &&
              !completeLinkedRegion
            )
              continue
            if (o !== dropCap && region.anchors.length && o.text.trim())
              region.prose.push({
                index: o.i,
                y: baseline,
                right: Math.max(
                  cos * o.bounds[0] + sin * o.bounds[1],
                  cos * o.bounds[2] + sin * o.bounds[3]
                ),
                bottom: Math.min(
                  -sin * o.bounds[0] + cos * o.bounds[1],
                  -sin * o.bounds[2] + cos * o.bounds[3]
                ),
                top: Math.max(
                  -sin * o.bounds[0] + cos * o.bounds[1],
                  -sin * o.bounds[2] + cos * o.bounds[3]
                ),
                x: Math.min(
                  cos * o.bounds[0] + sin * o.bounds[1],
                  cos * o.bounds[2] + sin * o.bounds[3]
                )
              })
            check(p.FPDFTextObj_GetTextRenderMode(o.obj) === 0)
            const clip = p.FPDFPageObj_GetClipPath(o.obj)
            // PDFium returns -1 for a valid object's empty (HasRef=false) clip path.
            // A referenced path with zero geometry may still clip text; reject it too.
            check(clip && p.FPDFClipPath_CountPaths(clip) === -1)
            check(p.FPDFTextObj_GetFontSize(o.obj, at))
            const point = explicitPowers.has(o.i) ? bodySize : e.m.HEAPF32[at / 4] * verticalScale
            check(point > 0 && point <= 100)
            mixedSizes ||= sourcePoint !== undefined && Math.abs(point - sourcePoint) >= 0.01
            sourcePoint = Math.min(sourcePoint ?? point, point)
            sourceSize = Math.max(8, sourcePoint)
            check(p.FPDFPageObj_GetFillColor(o.obj, at, at + 4, at + 8, at + 12))
            const color = Array.from(e.m.HEAPU32.slice(at / 4, at / 4 + 4))
            check(color[3] === 255)
            // A heading and its paragraph may have different fill colors. Reflow
            // uses the dominant prose color; this does not make the source unsafe.
            const key = color.join(','),
              count = (proseColors.get(key)?.count ?? 0) + o.text.trim().length
            proseColors.set(key, { color, count })
            sourceColor = [...proseColors.values()].reduce((a, b) =>
              a.count >= b.count ? a : b
            ).color
          }
          check(sourceSize !== undefined, 'annotations')
          // Headings and prose can use different sizes on ordinary text lines.
          // Unmatched superscripts/subscripts introduce a second nearby baseline;
          // never flatten those scientific glyphs into body text.
          if (mixedSizes || (region.anchors.length && !region.singleLine)) {
            // Matched inline anchors own their small superscript/subscript glyphs.
            // Exclude their baselines from the prose spacing check; otherwise a
            // valid paragraph with several inline formulas is rejected as an
            // unsupported layout and the whole translated paragraph is retained.
            const proseObjects = selected.filter((o) => {
              if (o === dropCap) return false
              // Publisher thin spaces can have the superscript baseline but no
              // ink. They are not an unmatched scientific glyph or a text line.
              if (!o.text.trim()) return false
              if (region.anchors.some((anchor) => anchor.indices.includes(o.i))) return false
              const sourceOffset = offsets.get(o.i),
                preceding =
                  sourceOffset === undefined
                    ? ''
                    : (/([A-Za-z\p{Script=Greek}]+)$/u.exec(
                        unit.source.slice(0, sourceOffset).replace(/(?:¯|\u0302)$/u, '')
                      )?.[1] ?? ''),
                inlineScript =
                  /^(?:st|nd|rd|th|[°◦]|[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2})$/iu.test(o.text.trim()) ||
                  ((o.text.replace(/\s/gu, '').length <= 2 ||
                    /^[a-z]=\d{1,3}$/u.test(o.text.trim())) &&
                    preceding.length > 0 &&
                    preceding.length <= 2)
              if (
                sizes.get(o.i) < bodySize * 0.9 &&
                inlineScript &&
                selected.some(
                  (other) =>
                    other !== o &&
                    sizes.get(other.i) >= bodySize * 0.9 &&
                    // Ordinal suffixes can sit several points above the
                    // body baseline while still belonging to the same line.
                    // Keep ordinary raised prose conservative.
                    Math.abs(objectBaselines.get(other.i) - objectBaselines.get(o.i)) <
                      bodySize * 0.5
                )
              ) {
                const marker = markers.find((marker) => marker.sourceIndices.includes(o.i)),
                  paired =
                    marker &&
                    markers.some(
                      (other) =>
                        other.scale < 0.9 &&
                        other.rise * marker.rise < 0 &&
                        (other.sourceOffset + other.label.length === marker.sourceOffset ||
                          marker.sourceOffset + marker.label.length === other.sourceOffset)
                    ),
                  ordinal =
                    /^(?:st|nd|rd|th)$/iu.test(o.text.trim()) &&
                    /\d$/u.test(unit.source.slice(0, sourceOffset))
                // Unmatched two-level indices and ordinal suffixes have no
                // proven replacement. Do not silently drop their native glyphs.
                check(
                  (!paired && !ordinal) ||
                    explicitPowers.has(o.i) ||
                    bodyBaselines.some(
                      (y) => Math.abs(y - objectBaselines.get(o.i)) < bodySize * 0.1
                    ),
                  'annotations'
                )
                return false
              }
              const text = nativeMathSymbolText(o, nativeFontName(o)).trim()
              return !/^[√∛∜∫∑∏]$/u.test(text)
            })
            // Independent native runs on one body line may differ by a fraction
            // of a point. Keep every glyph in that row; do not turn harmless
            // publisher rounding into a second overlapping line or a script.
            const proseRows = []
            const tolerance = Math.min(0.1, bodySize * 0.01)
            // The metrics pass already maps proven explicit powers to their
            // body row. Their raised native baselines are not separate prose
            // rows; keep that admission policy before clustering body jitter.
            const admittedProse = proseObjects.filter((object) =>
              region.baselines.some(
                (baseline) => Math.abs(objectBaselines.get(object.i) - baseline) < 0.01
              )
            )
            for (const object of admittedProse.sort(
              (a, b) => objectBaselines.get(b.i) - objectBaselines.get(a.i)
            )) {
              const baseline = objectBaselines.get(object.i),
                previous = proseRows.at(-1)
              if (previous && previous.top - baseline <= tolerance) {
                previous.bottom = baseline
                previous.objects.push(object)
              } else proseRows.push({ top: baseline, bottom: baseline, objects: [object] })
            }
            const baselinesFit = proseRows.every(
              (row, i) =>
                !i ||
                (proseRows[i - 1].bottom - row.top >=
                  (mixedSizes ? bodySize * 0.8 : sourceSize) - 0.01 &&
                  Math.min(
                    ...proseRows[i - 1].objects.map((o) =>
                      Math.min(
                        -sin * o.bounds[0] + cos * o.bounds[1],
                        -sin * o.bounds[2] + cos * o.bounds[3]
                      )
                    )
                  ) >=
                    Math.max(
                      ...row.objects.map((o) =>
                        Math.max(
                          -sin * o.bounds[0] + cos * o.bounds[1],
                          -sin * o.bounds[2] + cos * o.bounds[3]
                        )
                      )
                    ))
            )
            // A linked formula may leave a smaller native script on its own
            // baseline. Final glyph collision and annotation bounds still prove
            // the replacement; do not discard the surrounding prose solely for
            // this intermediate baseline envelope.
            if (!baselinesFit && !/(?:[=√∑βθ]|\u0302)/u.test(unit.source))
              check(false, 'annotations')
          }
          // A full-size URL on its own native row is ordinary text. Since
          // anchor objects are excluded from prose baselines, their line spacing
          // must not become a scientific subscript offset during reflow.
          for (const anchor of region.anchors) {
            const nativeObjects = selected.filter((object) => anchor.indices.includes(object.i)),
              uriRows = region.anchors.filter(
                (other) => other.annotation?.uri === anchor.annotation?.uri
              ),
              // A complete URI may use a slightly smaller monospace face over
              // several native rows. Their matching action, spelling, size and
              // spacing prove ordinary URL lines rather than scientific scripts.
              wrappedUri =
                uriRows.length > 1 &&
                uriRows
                  .map((other) => other.label)
                  .join('')
                  .replace(/\s/gu, '') === anchor.annotation?.uri &&
                uriRows.every(
                  (other, i) =>
                    !i || Math.abs(other.baseline - uriRows[i - 1].baseline) >= sourceSize * 0.8
                ) &&
                uriRows.every((other) =>
                  selected
                    .filter((object) => other.indices.includes(object.i))
                    .every(
                      (object) =>
                        sizes.get(object.i) >= sourceSize * 0.8 &&
                        sizes.get(object.i) <= sourceSize + 0.01 &&
                        Math.abs(sizes.get(object.i) - sizes.get(nativeObjects[0]?.i)) < 0.01
                    )
                )
            anchor.completeWrappedUri = wrappedUri
            // A raised footnote introducer and its complete URI form one native
            // row. Preserve the digit's exact rise relative to that URI, rather
            // than treating the entire URL as a subscript of the preceding prose.
            const footnotes = region.anchors.filter((marker) => {
                if (
                  marker === anchor ||
                  marker.generated ||
                  marker.annotation ||
                  marker.indices.length !== 1 ||
                  !/^\d{1,2}$/u.test(marker.label) ||
                  marker.sourceOffset + marker.label.length > anchor.sourceOffset ||
                  marker.targetOffset + marker.label.length > anchor.targetOffset ||
                  unit.source
                    .slice(marker.sourceOffset + marker.label.length, anchor.sourceOffset)
                    .trim() ||
                  unit.translation
                    .slice(marker.targetOffset + marker.label.length, anchor.targetOffset)
                    .trim()
                )
                  return false
                const object = selected.find((object) => marker.indices.includes(object.i)),
                  size = sizes.get(object?.i),
                  rise = marker.baseline - anchor.baseline
                return (
                  object &&
                  size >= sourceSize * 0.5 &&
                  size < sourceSize * 0.9 &&
                  rise > sourceSize * 0.2 &&
                  rise < sourceSize * 0.75 &&
                  object.bounds[2] <= anchor.origin &&
                  anchor.origin - object.bounds[2] <= sourceSize * 0.5 &&
                  Math.abs(objectBaselines.get(object.i) - marker.baseline) < 0.01
                )
              }),
              footnote =
                anchor.label === anchor.annotation?.uri && footnotes.length === 1
                  ? footnotes[0]
                  : undefined
            if (
              !anchor.generated &&
              /^https?:\/\/\S+$/u.test(anchor.annotation?.uri ?? '') &&
              anchor.annotation.uri.includes(anchor.label) &&
              [unit.source, unit.translation].every(
                (text) => text.replace(/\s/gu, '').split(anchor.annotation.uri).length === 2
              ) &&
              anchor.indices.length &&
              nativeObjects.length === anchor.indices.length &&
              nativeObjects.every(
                (object) =>
                  (Math.abs(sizes.get(object.i) - sourceSize) < 0.01 || wrappedUri) &&
                  Math.abs(objectBaselines.get(object.i) - anchor.baseline) < 0.01
              ) &&
              region.baselines.length &&
              region.baselines.every(
                (baseline) => Math.abs(baseline - anchor.baseline) >= sourceSize * 0.8
              ) &&
              selected
                .filter((object) => !anchor.indices.includes(object.i) && object.text.trim())
                .every((object) => {
                  if (footnote?.indices.includes(object.i)) return true
                  const bottom = Math.min(
                      -sin * object.bounds[0] + cos * object.bounds[1],
                      -sin * object.bounds[2] + cos * object.bounds[3]
                    ),
                    top = Math.max(
                      -sin * object.bounds[0] + cos * object.bounds[1],
                      -sin * object.bounds[2] + cos * object.bounds[3]
                    ),
                    anchorBottom = Math.min(
                      -sin * anchor.link.left + cos * anchor.link.bottom,
                      -sin * anchor.link.right + cos * anchor.link.top
                    ),
                    anchorTop = Math.max(
                      -sin * anchor.link.left + cos * anchor.link.bottom,
                      -sin * anchor.link.right + cos * anchor.link.top
                    )
                  return top <= anchorBottom || bottom >= anchorTop
                })
            ) {
              anchor.nativeRowBaseline = anchor.baseline
              if (footnote) {
                anchor.nativeUriFootnote = true
                footnote.scriptRise = footnote.baseline - anchor.baseline
                footnote.nativeRowBaseline = anchor.baseline
                footnote.nativeFootnoteRow = true
              }
            }
          }
        } finally {
          e.free(at)
        }
      }
      // Fit in the source text's local horizontal axes, then rotate glyphs back on insertion.
      const localPoint = (x, y) => [cos * x + sin * y, -sin * x + cos * y]
      // Claim a complete native object for deletion, but never use its leading
      // punctuation overhang as extra space for translated prose.
      const admitted = fragmentBounds(fragment),
        layoutLeft = Math.max(admitted.x, sourceRect.x),
        layoutRight = Math.min(admitted.x + admitted.width, sourceRect.x + sourceRect.width),
        layoutRect = { ...sourceRect, x: layoutLeft, width: layoutRight - layoutLeft }
      const rect = boundsBetween(
        localPoint(layoutRect.x, layoutRect.bottom),
        localPoint(layoutRect.x + layoutRect.width, layoutRect.top)
      )
      const anchors = regions.at(-1).anchors
      for (const anchor of anchors) {
        for (const annotation of anchor.annotation
          ? [anchor.annotation, ...(anchor.additionalAnnotations ?? [])]
          : [])
          check(linkFits(sourceRect, anchor, annotation), 'annotations')
        if (anchor.glyphBounds)
          anchor.localGlyphs = boundsBetween(
            localPoint(anchor.glyphBounds.left, anchor.glyphBounds.bottom),
            localPoint(anchor.glyphBounds.right, anchor.glyphBounds.top)
          )
        anchor.local = boundsBetween(
          localPoint(anchor.link.left, anchor.link.bottom),
          localPoint(anchor.link.right, anchor.link.top)
        )
        // Native glyph ink can start after its text origin (e.g. a serif list
        // number). Reserve that side bearing when reflowing, so the retained
        // text origin stays inside the same box as the surrounding prose.
        if (anchor.origin < anchor.local.x) {
          anchor.local.width += anchor.local.x - anchor.origin
          anchor.local.x = anchor.origin
        }
        // A complete URI on its own proven native row can have a click box
        // wider than its text region. Budget its original glyph advance here;
        // keep the click padding intact for linkFits and final paint preflight.
        if (
          ((anchor.nativeRowBaseline !== undefined && anchor.label === anchor.annotation?.uri) ||
            anchor.completeWrappedUri) &&
          anchor.localGlyphs &&
          (anchor.local.width > rect.width ||
            anchor.completeWrappedUri ||
            anchor.nativeUriFootnote) &&
          anchor.origin >= rect.x &&
          anchor.localGlyphs.x >= anchor.origin &&
          anchor.localGlyphs.x + anchor.localGlyphs.width <= rect.x + rect.width
        )
          anchor.nativeRowWidth =
            Math.max(
              anchor.localGlyphs.x + anchor.localGlyphs.width,
              // Wrapped segments reserve their actual annotation edge too;
              // trailing translated punctuation cannot enter the click area.
              anchor.completeWrappedUri ? anchor.local.x + anchor.local.width : -Infinity
            ) - (anchor.completeWrappedUri ? anchor.local.x : anchor.origin)
      }
      anchors.sort((a, b) => a.sourceOffset - b.sourceOffset)
      const targetOrder = anchors.toSorted((a, b) => a.targetOffset - b.targetOffset)
      check(
        targetOrder.every(
          (anchor, index) =>
            !index ||
            targetOrder[index - 1].targetOffset + targetOrder[index - 1].label.length <=
              anchor.targetOffset
        ),
        'annotations'
      )
      // Scientific scripts and registration marks must follow their identifier,
      // rather than stay detached at their former horizontal position.
      let fixed = !anchors.some(
        (anchor) =>
          anchor.generated ||
          anchor.registeredBrand ||
          anchor.scriptOnlyPower ||
          (!anchor.prose && /^[\d⁰¹²³⁴⁵⁶⁷⁸⁹,.;:–−-]+$/u.test(anchor.label))
      )
      for (let i = 1; i < anchors.length; i++) {
        const previous = anchors[i - 1],
          current = anchors[i]
        if (previous.generated || current.generated) {
          fixed = false
          continue
        }
        fixed &&=
          (previous.local.x + previous.local.width <= current.local.x &&
            previous.local.bottom < current.local.top &&
            current.local.bottom < previous.local.top) ||
          previous.local.bottom >= current.local.top
        const ordered = previous.targetOffset + previous.label.length <= current.targetOffset
        fixed &&= ordered
        check(
          (previous.generated ||
            current.generated ||
            previous.sourceOffset + (previous.sourceLabel ?? previous.label).length <=
              current.sourceOffset) &&
            (previous.generated ||
              current.generated ||
              (previous.textIndices ?? previous.indices).at(-1) <
                (current.textIndices ?? current.indices)[0]),
          'annotations'
        )
      }
      const baselines = regions.at(-1).baselines.toSorted((a, b) => b - a)
      Object.assign(regions.at(-1), {
        local: rect,
        fixed,
        cos,
        sin,
        sourceSize,
        minimumPoint: Math.min(8, sourcePoint),
        // Keep dense reference lists close to their source leading without
        // reducing font size or allowing adjacent glyphs to overlap.
        lineHeight: Math.min(
          1.35,
          ...baselines.slice(1).map((y, i) => Math.max(1.2, (baselines[i] - y) / sourceSize))
        ),
        sourceBaseline,
        color: sourceColor
      })
    }
    if (unchanged) {
      // Tiny nested/form text objects may be returned by PDFium together with
      // an adjacent glyph. Since this unit is unchanged, retaining the whole
      // verified box is safe when the requested source is still present in the
      // bounded text and there is no owned object to delete.
      if (
        regions.length === 1 &&
        !regions[0].objectIndices.length &&
        normalized(regions[0].source).join('').endsWith(normalized(unit.source).join(''))
      ) {
        plans.push({ ...regions[0], verifiedObjects: false })
        return
      }
      // A fragmented paragraph can require object text in one region (e.g. an
      // independently proven math accent) and a bounded read in another (e.g.
      // punctuation sharing a larger object). Match exact source prefixes across
      // regions; never accept a character multiset or skip mismatched text.
      let proofs = new Map([[0, []]])
      for (const [regionIndex, region] of regions.entries()) {
        const next = new Map(),
          verifiedHyphens = geometry[region.fragment.pageNumber - 1].verifiedHyphens(region.rect)
        for (const [cursor, proof] of proofs) {
          for (const [text, verifiedObjects, sourceObjects] of [
            [region.objectSource, true, region.sourceObjects],
            [region.containedSource, true],
            [region.nestedSource, false],
            [region.source, false]
          ]) {
            if (!text?.trim()) continue
            const aligned = objectSourceOffsets(
              unit.source.slice(cursor),
              sourceObjects ?? [{ i: 0, text }],
              verifiedHyphens,
              true,
              false,
              regionIndex < regions.length - 1
            )
            if (!aligned.endOffset) continue
            const end = cursor + aligned.endOffset
            if (!next.has(end)) next.set(end, [...proof, verifiedObjects])
          }
        }
        if (!next.size || (regionIndex === regions.length - 1 && !next.has(unit.source.length))) {
          const text = nativeReadingOrder(
            e,
            planningPage(region.fragment.pageNumber).page,
            region.rect
          )
          if (text) {
            for (const [cursor, proof] of proofs) {
              const aligned = objectSourceOffsets(
                unit.source.slice(cursor),
                [{ i: 0, text }],
                verifiedHyphens,
                true
              )
              if (aligned.endOffset) next.set(cursor + aligned.endOffset, [...proof, false])
            }
          }
        }
        check(next.size > 0 && next.size <= 128, 'source-mismatch')
        proofs = next
      }
      const proof = proofs.get(unit.source.length)
      check(proof, 'source-mismatch')
      plans.push(...regions.map((region, index) => ({ ...region, verifiedObjects: proof[index] })))
      return
    }
    check(
      sourceMatches(
        unit.source,
        regions.map((r) => r.matchingSource ?? r.source).join(''),
        regions.every((r) => geometry[r.fragment.pageNumber - 1].verifiedHyphens(r.rect))
      ),
      'source-mismatch'
    )
    // A merged label column must not flow independently of neighboring numeric
    // rows. Two aligned values in one adjacent column establish the risk; retain
    // the verified original until cell-level translations can preserve row identity.
    for (const region of regions) {
      if (region.baselines.length < 2) continue
      const localPoint = (x, y) => [
        region.cos * x + region.sin * y,
        -region.sin * x + region.cos * y
      ]
      const size = pages[region.fragment.pageNumber - 1],
        origin = geometry[region.fragment.pageNumber - 1]
      const values = units
        .filter(
          (other) =>
            other !== unit && /\d/.test(other.source) && /^[\d\s.,%()+−–\-=:]+$/u.test(other.source)
        )
        .flatMap((other) =>
          other.fragments.filter((fragment) => fragment.pageNumber === region.fragment.pageNumber)
        )
        .map(({ rect: r }) => {
          const box = boundsBetween(
            origin.toPdf(r.x * size.width, r.y * size.height),
            origin.toPdf((r.x + r.width) * size.width, (r.y + r.height) * size.height)
          )
          return boundsBetween(
            localPoint(box.x, box.bottom),
            localPoint(box.x + box.width, box.top)
          )
        })
        .filter(
          (box) =>
            box.x >= region.local.x + region.local.width || box.x + box.width <= region.local.x
        )
        .map((box) => ({
          box,
          row: region.baselines.findIndex(
            (baseline) => Math.abs((box.bottom + box.top) / 2 - baseline) < region.sourceSize * 0.75
          )
        }))
        .filter(({ row }) => row >= 0)
      // Distance alone cannot distinguish a sparse table from another column.
      // A plotted curve between the columns provides independent graphic content;
      // plain whitespace, rectangular cell borders and straight rules do not.
      const plots = []
      if (values.length > 1) {
        const { objects } = planningPage(region.fragment.pageNumber),
          at = e.alloc(24)
        try {
          const paths = objects.flatMap((object) => {
            if (object.type === 2) return [object]
            if (object.type !== 5) return []
            const parent = boundsBetween(
              localPoint(object.bounds[0], object.bounds[1]),
              localPoint(object.bounds[2], object.bounds[3])
            )
            // Ticks inside an independently placed plotted Form belong to that
            // figure, not to a prose/table column outside the Form.
            if (
              parent.x < region.local.x + region.local.width &&
              parent.x + parent.width > region.local.x
            )
              return []
            check(p.FPDFPageObj_GetIsActive(object.obj, at))
            if (!e.m.HEAP32[at / 4]) return []
            check(p.FPDFPageObj_GetMatrix(object.obj, at))
            const outer = Array.from(e.m.HEAPF32.slice(at / 4, at / 4 + 6)),
              children = []
            for (let index = 0; index < p.FPDFFormObj_CountObjects(object.obj); index++) {
              const obj = p.FPDFFormObj_GetObject(object.obj, index)
              if (p.FPDFPageObj_GetType(obj) === 2)
                children.push({ obj, bounds: e.bounds(obj), parent, outer })
            }
            return children
          })
          for (const object of paths) {
            const [oa, ob, oc, od, ox, oy] = object.outer ?? [1, 0, 0, 1, 0, 0],
              toLocal = (x, y) => localPoint(oa * x + oc * y + ox, ob * x + od * y + oy),
              box = boundsBetween(
                toLocal(object.bounds[0], object.bounds[1]),
                toLocal(object.bounds[2], object.bounds[3])
              )
            if (box.width < region.sourceSize || box.top - box.bottom < region.sourceSize / 2)
              continue
            const clip = p.FPDFPageObj_GetClipPath(object.obj)
            if (!clip || p.FPDFClipPath_CountPaths(clip) !== -1) continue
            check(p.FPDFPageObj_GetIsActive(object.obj, at))
            if (!e.m.HEAP32[at / 4]) continue
            check(p.FPDFPath_GetDrawMode(object.obj, at, at + 4))
            if (!e.m.HEAP32[at / 4 + 1]) continue
            check(p.FPDFPageObj_GetStrokeColor(object.obj, at, at + 4, at + 8, at + 12))
            if (!e.m.HEAPU32[at / 4 + 3]) continue
            check(p.FPDFPageObj_GetMatrix(object.obj, at))
            const [a, b, c, d] = e.m.HEAPF32.slice(at / 4, at / 4 + 4)
            let previous,
              first,
              bent = false
            for (let i = 0; i < p.FPDFPath_CountSegments(object.obj); i++) {
              const segment = p.FPDFPath_GetPathSegment(object.obj, i),
                type = p.FPDFPathSegment_GetType(segment)
              check(p.FPDFPathSegment_GetPoint(segment, at, at + 4))
              const point = Array.from(e.m.HEAPF32.slice(at / 4, at / 4 + 2))
              if (previous && type === 0) {
                const dx = point[0] - previous[0],
                  dy = point[1] - previous[1],
                  tx = a * dx + c * dy,
                  ty = b * dx + d * dy,
                  [x, y] = localPoint(oa * tx + oc * ty, ob * tx + od * ty),
                  length = Math.hypot(x, y)
                if (Math.abs(x) > 0.1 && Math.abs(y) > 0.1) {
                  const direction = [x / length, y / length]
                  if (first && Math.abs(first[0] * direction[1] - first[1] * direction[0]) > 0.05)
                    bent = true
                  first ??= direction
                }
              }
              previous = type === 0 || type === 2 ? point : undefined
            }
            if (bent) plots.push({ ...box, parent: object.parent })
          }
        } finally {
          e.free(at)
        }
      }
      const separatedByPlot = (a, b) => {
        if (
          plots.some(
            ({ parent }) =>
              parent &&
              [a.box, b.box].every(
                (box) =>
                  box.x >= parent.x - objectTolerance &&
                  box.x + box.width <= parent.x + parent.width + objectTolerance &&
                  box.bottom >= parent.bottom - objectTolerance &&
                  box.top <= parent.top + objectTolerance
              )
          )
        )
          return true
        const left =
            Math.min(a.box.x, b.box.x) >= region.local.x + region.local.width
              ? region.local.x + region.local.width
              : Math.max(a.box.x + a.box.width, b.box.x + b.box.width),
          right =
            Math.min(a.box.x, b.box.x) >= region.local.x + region.local.width
              ? Math.min(a.box.x, b.box.x)
              : region.local.x,
          between = plots.filter((box) => box.x > left && box.x + box.width < right)
        return (
          between.length > 0 &&
          Math.min(...between.map((box) => box.bottom)) <=
            Math.min(a.box.bottom, b.box.bottom) + region.sourceSize &&
          Math.max(...between.map((box) => box.top)) >=
            Math.max(a.box.top, b.box.top) - region.sourceSize
        )
      }
      check(
        !values.some((a, index) =>
          values
            .slice(index + 1)
            .some(
              (b) =>
                a.row !== b.row &&
                a.box.x < b.box.x + b.box.width &&
                b.box.x < a.box.x + a.box.width &&
                !separatedByPlot(a, b)
            )
        )
      )
    }
    check(unit.translation.length <= 8000, 'overflow')
    check(!/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(unit.translation), 'font')
    let glyphOffset = 0,
      unsupportedScript = false
    check(
      [...unit.translation].every((c) => {
        const offset = glyphOffset
        glyphOffset += c.length
        // Retained inline objects use the publisher's original font, including
        // scientific footnote symbols absent from the translated prose font.
        const supported =
          face.hasGlyphForCodePoint(greekGlyph(c).codePointAt(0)) ||
          regions.some((region) =>
            region.anchors.some(
              (anchor) =>
                !anchor.generated &&
                offset >= anchor.targetOffset &&
                offset < anchor.targetOffset + anchor.label.length
            )
          )
        unsupportedScript ||= !supported && /^[⁰¹²³⁴⁵⁶⁷⁸⁹]$/u.test(c)
        return supported
      }),
      unsupportedScript ? 'unsupported-layout' : 'font'
    )
    const ends = pdfTranslationLineEnds(unit.translation)
    // Shape in font units once, then scale for each fitting attempt. Bound the
    // cache so long scientific paragraphs cannot accumulate quadratic strings.
    const measurements = new Map()
    const measure = (text, point) => {
      let ink = measurements.get(text)
      if (!ink) {
        const run = face.layout(shapeGreek(text), { liga: false, kern: false })
        let x = 0,
          left = 0,
          right = 0,
          top = 0,
          bottom = 0
        run.glyphs.forEach((glyph, i) => {
          const at = run.positions[i],
            box = glyph.bbox
          left = Math.min(left, x + at.xOffset + box.minX)
          right = Math.max(right, x + at.xOffset + box.maxX)
          top = Math.max(top, at.yOffset + box.maxY)
          bottom = Math.min(bottom, at.yOffset + box.minY)
          x += at.xAdvance
        })
        ink = { left, width: Math.max(x, right) - left, top, bottom }
        if (measurements.size < 256) measurements.set(text, ink)
      }
      const scale = point / face.unitsPerEm
      return {
        left: ink.left * scale,
        width: ink.width * scale,
        top: ink.top * scale,
        bottom: ink.bottom * scale
      }
    }
    const anchorInk = (anchor, point) => {
      if (!anchor.generated)
        return {
          left: 0,
          width:
            anchor.nativeRowWidth ?? anchor.local.width + (anchor.annotation ? point * 0.15 : 0),
          top: (anchor.localGlyphs ?? anchor.local).top - anchor.baseline + anchor.rise,
          bottom: (anchor.localGlyphs ?? anchor.local).bottom - anchor.baseline + anchor.rise,
          occupiedTop:
            Math.max(anchor.local.top, (anchor.localGlyphs ?? anchor.local).top) -
            anchor.baseline +
            anchor.rise,
          occupiedBottom:
            Math.min(anchor.local.bottom, (anchor.localGlyphs ?? anchor.local).bottom) -
            anchor.baseline +
            anchor.rise
        }
      const natural = measure(anchor.label, point * anchor.scale)
      const fittedPoint =
        point *
        anchor.scale *
        (anchor.annotation
          ? Math.min(
              1,
              anchor.local.width / natural.width,
              anchor.local.height / (natural.top - natural.bottom)
            )
          : 1)
      const ink = measure(anchor.label, fittedPoint)
      const rise = anchor.annotation
        ? anchor.rise +
          (anchor.local.top + anchor.local.bottom - 2 * anchor.baseline - ink.top - ink.bottom) / 2
        : anchor.rise
      return {
        ...ink,
        point: fittedPoint,
        width: anchor.annotation
          ? Math.max(anchor.local.width, ink.width) + point * 0.15
          : ink.width + point * 0.1,
        // The original click rectangle is not glyph ink. Keep its dimensions
        // separately for annotation movement admission below.
        top: ink.top + rise,
        bottom: ink.bottom + rise,
        occupiedTop: Math.max(
          ink.top + rise,
          anchor.annotation ? anchor.local.top - anchor.baseline + anchor.rise : -Infinity
        ),
        occupiedBottom: Math.min(
          ink.bottom + rise,
          anchor.annotation ? anchor.local.bottom - anchor.baseline + anchor.rise : Infinity
        ),
        rise
      }
    }
    const anchorLine = (anchor, point, x, baseline) => {
      const line = {
        anchor,
        dx:
          x -
          (anchor.nativeRowWidth === undefined || anchor.completeWrappedUri
            ? anchor.local.x
            : anchor.origin),
        dy: baseline + anchor.rise - anchor.baseline
      }
      if (!anchor.generated) return { ...line, indices: anchor.indices }
      const ink = anchorInk(anchor, point)
      return {
        ...line,
        text: anchor.label,
        point: ink.point,
        // Regenerated scripts need a small side bearing on each side: native
        // PDF glyph bounds can extend beyond fontkit's advance at this size.
        // A proven URI tail can be narrower in the translation font than its
        // unchanged click rectangle. Align its final glyph advance with that
        // rectangle so translated sentence punctuation stays beside the URL.
        x:
          x -
          ink.left +
          (anchor.nativeUriTail
            ? Math.max(0, anchor.local.width - measure(anchor.label, ink.point).width)
            : anchor.annotation
              ? 0
              : point * 0.03),
        y: baseline + ink.rise
      }
    }
    // Reject a candidate during fitting, so a smaller font can still be tried.
    // Final preflight repeats this check before mutating any native objects.
    const reflowedLinksFit = (region, lines) =>
      lines.every(({ anchor, dx, dy }) => {
        if (!anchor || (anchor.generated && !anchor.annotation)) return true
        const x = region.cos * dx - region.sin * dy,
          y = region.sin * dx + region.cos * dy
        return linkFits(region.rect, anchor, {
          left: anchor.link.left + x,
          right: anchor.link.right + x,
          bottom: anchor.link.bottom + y,
          top: anchor.link.top + y
        })
      })
    // Small plot labels are already below the body-text floor. Preserve their
    // original size instead of enlarging them to 8 pt and forcing a fallback.
    const minimumPoint = Math.min(...regions.map((region) => region.minimumPoint))
    // Check inter-fragment ink while choosing a font, so a colliding candidate
    // can retry at a smaller readable size instead of retaining the whole source.
    const regionsFit = (candidate) => {
      // Collision ownership follows verified source and final glyph ink, not empty
      // font-box margins. Keep mutation/fit rectangles and native collision checks.
      for (const region of candidate) {
        if (!region.sourceInk || region.cos !== 1 || region.sin !== 0) continue
        const boxes = [...region.sourceInkBoxes]
        for (const line of region.lines) {
          if (line.text) {
            const ink = measure(line.text, line.point ?? region.point)
            boxes.push({
              x: line.x + ink.left * (line.horizontalScale ?? 1),
              width: ink.width * (line.horizontalScale ?? 1),
              bottom: line.y + ink.bottom,
              top: line.y + ink.top
            })
          }
          if (line.anchor) {
            const anchor = line.anchor
            for (const box of !anchor.generated ? [anchor.glyphBounds ?? anchor.link] : [])
              boxes.push({
                x: box.left + line.dx,
                width: box.right - box.left,
                bottom: box.bottom + line.dy,
                top: box.top + line.dy
              })
          }
        }
        // Fragments of one paragraph can have overlapping envelopes but disjoint ink.
        // Keep each proven source/final box for the narrow collision check.
        region.collisionBoxes = boxes
        region.collisionRect = boundsBetween(
          [
            Math.min(...boxes.map((box) => box.x)) - 0.01,
            Math.min(...boxes.map((box) => box.bottom)) - 0.01
          ],
          [
            Math.max(...boxes.map((box) => box.x + box.width)) + 0.01,
            Math.max(...boxes.map((box) => box.top)) + 0.01
          ]
        )
      }
      const separated = candidate.every((region, index) =>
        candidate.slice(0, index).every((other) => !regionsOverlap(other, region, true))
      )
      if (!separated) overlappingCandidate = true
      return separated
    }
    let fitted,
      overlappingCandidate = false
    const compactLeading =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
        unit.translation
      ) && regions.every((region) => !region.anchors.length && region.baselines.length > 1)
    // Normal leading remains the first choice. Dense native cells can fit CJK
    // ink at the same readable font size with a smaller, still positive row gap.
    for (const compact of compactLeading ? [false, true] : [false]) {
      if (fitted) break
      for (
        let point = Math.min(...regions.map((r) => r.sourceSize));
        point >= minimumPoint && !fitted;
        point = point > minimumPoint ? Math.max(minimumPoint, point - 0.5) : 0
      ) {
        // Anchored paragraphs spanning regions use the ownership-aware reflow below.
        if (regions.length > 1 && regions.some((region) => region.anchors.length)) break
        let start = 0
        const flowed = []
        for (const original of regions) {
          const region = compact ? { ...original, lineHeight: 1.1, compactLeading: true } : original
          const rect = region.local,
            lines = []
          if (region.anchors.length) {
            const { anchors } = region
            if (!region.fixed) break
            let fits = true,
              offset = 0
            for (let gap = 0; gap <= anchors.length; gap++) {
              const previous = anchors[gap - 1],
                next = anchors[gap]
              if (previous) {
                lines.push({ indices: previous.indices })
                offset = previous.targetOffset + previous.label.length
              }
              // Original glyph positions already account for gap whitespace.
              const text = unit.translation.slice(offset, next?.targetOffset).trim()
              if (!text) continue
              const sourceStarts = region.prose.filter(
                (o) =>
                  o.index > (previous?.indices.at(-1) ?? -1) &&
                  o.index < (next?.indices[0] ?? Infinity)
              )
              const areas = []
              if (region.singleLine) {
                areas.push({
                  x: Math.max(
                    previous ? Math.max(rect.x, previous.local.x + previous.local.width) : rect.x,
                    sourceStarts.length ? Math.min(...sourceStarts.map((o) => o.x)) : rect.x
                  ),
                  right: next ? Math.min(rect.x + rect.width, next.local.x) : rect.x + rect.width,
                  top: rect.top,
                  bottom: rect.bottom,
                  y: region.sourceBaseline
                })
              } else {
                // Only use baselines and indentation actually owned by this gap.
                // Never flow translated text across a fixed link or into a new line.
                for (const o of sourceStarts) {
                  let area = areas.at(-1)
                  if (!area || Math.abs(area.y - o.y) >= 0.01) {
                    check(!area || area.y - o.y >= region.sourceSize - 0.01, 'annotations')
                    area = {
                      x: o.x,
                      lastX: o.x,
                      right: rect.x + rect.width,
                      y: o.y,
                      top: Math.min(rect.top, o.y + region.sourceSize),
                      bottom: Math.max(rect.bottom, o.y - region.sourceSize * 0.35)
                    }
                    areas.push(area)
                  }
                  check(o.x >= area.lastX - objectTolerance, 'annotations')
                  area.lastX = o.x
                  const intersects = (anchor) =>
                    anchor &&
                    (o.bottom + o.top) / 2 < anchor.local.top &&
                    (o.bottom + o.top) / 2 > anchor.local.bottom
                  if (intersects(previous))
                    area.x = Math.max(area.x, previous.local.x + previous.local.width)
                  if (intersects(next)) area.right = Math.min(area.right, next.local.x)
                }
              }
              const breaks = pdfTranslationLineEnds(text)
              let cursor = 0
              for (const area of areas) {
                if (cursor === text.length) break
                let stop = cursor,
                  ink
                for (const end of breaks) {
                  if (end <= cursor) continue
                  const candidate = measure(text.slice(cursor, end), point)
                  if (candidate.width > area.right - area.x) break
                  stop = end
                  ink = candidate
                }
                if (stop === cursor) break
                // A publisher's tall footnote hit area can graze the next line.
                // Use only spare space in this owned line, and carry the ceiling
                // into native font preflight instead of trusting estimated glyph ink.
                let ceiling = area.top
                for (const anchor of anchors) {
                  if (
                    anchor.overhang &&
                    area.x + ink.width > anchor.local.x &&
                    area.x < anchor.local.x + anchor.local.width &&
                    area.y < anchor.local.bottom &&
                    area.y + ink.top > anchor.local.bottom
                  )
                    ceiling = Math.min(ceiling, anchor.local.bottom - 0.01)
                }
                const baseline = ceiling < area.top ? Math.min(area.y, ceiling - ink.top) : area.y
                if (
                  baseline < area.y - point * 0.2 ||
                  baseline + ink.top > area.top ||
                  baseline + ink.bottom < area.bottom
                )
                  break
                const world = (x, y) => [
                  region.cos * x - region.sin * y,
                  region.sin * x + region.cos * y
                ]
                lines.push({
                  text: text.slice(cursor, stop),
                  x: area.x - ink.left,
                  y: baseline,
                  rect: boundsBetween(world(area.x, area.bottom), world(area.right, ceiling))
                })
                cursor = stop
              }
              if (cursor !== text.length) {
                fits = false
                break
              }
            }
            if (fits)
              fits = lines.every((line) => {
                if (line.indices) return true
                const ink = measure(line.text, point)
                return anchors.every(
                  (anchor) =>
                    line.x + ink.left >= anchor.local.x + anchor.local.width ||
                    line.x + ink.left + ink.width <= anchor.local.x ||
                    line.y + ink.bottom >= anchor.local.top ||
                    line.y + ink.top <= anchor.local.bottom
                )
              })
            if (fits) {
              check(
                lines.some((line) => line.text?.trim()),
                'annotations'
              )
              start = unit.translation.length
            }
            flowed.push({ ...region, point, lines })
            continue
          }
          while (start < unit.translation.length) {
            let stop = start,
              ink
            for (const end of ends) {
              if (end <= start) continue
              const next = measure(unit.translation.slice(start, end), point)
              if (next.width > rect.width) break
              stop = end
              ink = next
            }
            if (stop === start) break
            let baseline = lines.length
              ? lines.at(-1).y - point * region.lineHeight
              : Math.min(region.sourceBaseline, rect.top - ink.top)
            // CJK descenders can need more room than the source's Latin baseline.
            // Use spare space above this block without enlarging its owned rectangle.
            const lift = Math.max(0, rect.bottom - baseline - ink.bottom)
            if (lift) {
              if (
                baseline + lift + ink.top > rect.top ||
                lines.some((line) => line.y + lift + measure(line.text, point).top > rect.top)
              )
                break
              for (const line of lines) line.y += lift
              baseline += lift
            }
            lines.push({
              text: unit.translation.slice(start, stop),
              x: rect.x - ink.left,
              y: baseline
            })
            start = stop
          }
          if (
            compact &&
            lines.some(
              (line, index) =>
                index &&
                lines[index - 1].y +
                  measure(lines[index - 1].text, point).bottom -
                  (line.y + measure(line.text, point).top) <
                  0.01
            )
          )
            break
          flowed.push({ ...region, point, lines })
        }
        if (
          flowed.length === regions.length &&
          start === unit.translation.length &&
          regionsFit(flowed)
        )
          fitted = flowed
      }
    }
    if (!fitted && regions.length > 1 && regions.some((region) => region.anchors.length)) {
      const anchors = regions.flatMap((region, owner) =>
        region.anchors.map((anchor) => {
          const closest = region.baselines.reduce(
            (nearest, baseline) =>
              Math.abs(baseline - anchor.baseline) < Math.abs(nearest - anchor.baseline)
                ? baseline
                : nearest,
            region.sourceBaseline
          )
          const rise = anchor.scriptRise ?? anchor.baseline - (anchor.nativeRowBaseline ?? closest)
          return Object.assign(anchor, {
            owner,
            rise
          })
        })
      )
      const flowable = anchors.every((anchor) => anchor.movable && Number.isFinite(anchor.baseline))
      const referencePrefixes = new Map()
      for (const anchor of anchors) {
        const prefix = /(?:\b(?:Figure|Fig\.?|Table|Tab\.?|Theorem)|[图圖表]|定理)\s*$/iu,
          original = unit.source.slice(0, anchor.sourceOffset).match(prefix),
          translated = unit.translation.slice(0, anchor.targetOffset).match(prefix),
          sourceNumber = unit.source.slice(anchor.sourceOffset).match(/^\d+/u)?.[0],
          targetNumber = unit.translation.slice(anchor.targetOffset).match(/^\d+/u)?.[0],
          identity = original && sourceNumber && pdfLinkLabelKey(original[0] + sourceNumber)
        if (
          identity &&
          translated &&
          targetNumber &&
          pdfLinkLabelKey(translated[0] + targetNumber) === identity
        )
          referencePrefixes.set(anchor, anchor.targetOffset - translated[0].length)
      }
      const boundaries = [
        ...new Set([
          0,
          ...ends,
          ...referencePrefixes.values(),
          ...anchors.flatMap((a) => [a.targetOffset, a.targetOffset + a.label.length])
        ])
      ]
        .filter(
          (at) =>
            !anchors.some((a) => at > a.targetOffset && at < a.targetOffset + a.label.length) &&
            !anchors.some((a) => at > referencePrefixes.get(a) && at < a.targetOffset)
        )
        .sort((a, b) => a - b)
      const groups = []
      for (let i = 1; i < boundaries.length; i++) {
        const start = boundaries[i - 1],
          anchor = anchors.find((a) => a.targetOffset === start)
        const token = anchor ? { anchor } : { text: unit.translation.slice(start, boundaries[i]) }
        const previous = groups.at(-1),
          previousAnchor = previous?.at(-1).anchor,
          uri = token.anchor?.annotation?.uri,
          wrappedUriBreak =
            uri &&
            uri === previousAnchor?.annotation?.uri &&
            token.anchor.targetOffset ===
              previousAnchor.targetOffset + previousAnchor.label.length &&
            Math.abs(token.anchor.baseline - previousAnchor.baseline) >= minimumPoint * 0.8 &&
            pdfLinkAddressMatches(unit.source).some(
              (address) =>
                address.text.replace(/ /gu, '') === uri &&
                previousAnchor.sourceOffset >= address.index &&
                token.anchor.sourceOffset +
                  (token.anchor.sourceLabel ?? token.anchor.label).length <=
                  address.index + address.text.length
            )
        if (
          previous &&
          !token.anchor?.nativeFootnoteRow &&
          (/^[，。！？；：、,.;:!?）)］\]｝}》」』】”’％%]/u.test((token.text ?? '').trimStart()) ||
            /[（(［[｛{《「『【“‘]$/u.test((previous.at(-1).text ?? '').trimEnd()) ||
            (token.anchor &&
              !wrappedUriBreak &&
              !/[\s，,；;]$/u.test(previous.at(-1).text ?? '')) ||
            // A typed reference prefix belongs to the native number's region,
            // including intervening whitespace. Its identity was proven above;
            // a bare measurement or changed reference type gains no ownership.
            (token.anchor &&
              referencePrefixes.has(token.anchor) &&
              previous.at(-1).text ===
                unit.translation.slice(
                  referencePrefixes.get(token.anchor),
                  token.anchor.targetOffset
                )))
        )
          previous.push(token)
        else groups.push([token])
      }
      const compactLinkedLeading =
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
          unit.translation
        ) &&
        anchors.every((anchor) => anchor.annotation) &&
        regions.every(
          (region) =>
            region.cos === 1 &&
            region.sin === 0 &&
            region.baselines.length > 1 &&
            region.baselines
              .toSorted((a, b) => b - a)
              .every(
                (baseline, index, rows) =>
                  !index ||
                  (rows[index - 1] - baseline >= region.sourceSize * 0.8 &&
                    rows[index - 1] - baseline <= region.sourceSize * 1.7)
              )
        )
      // Preserve ordinary flow first. Dense linked prose can use the existing
      // compact gap only with complete hit areas and final ink/link preflight.
      for (const [reserveHitArea, compact] of [
        [false, false],
        [true, false],
        ...(compactLinkedLeading ? [[true, true]] : [])
      ]) {
        if (fitted) break
        for (
          let point = Math.min(...regions.map((r) => r.sourceSize));
          flowable && point >= minimumPoint && !fitted;
          point = point > minimumPoint ? Math.max(minimumPoint, point - 0.5) : 0
        ) {
          // A retry uses fresh rows and owners; the first validated plan remains the fallback.
          const flowGroups = (groups) => {
            let fitted
            const seams = [],
              rows = regions.map(() => [])
            let owner = 0,
              valid = true
            for (const [groupIndex, group] of groups.entries()) {
              const owners = new Set(
                group
                  .filter((token) => token.anchor && !token.anchor.generated)
                  .map((token) => token.anchor.owner)
              )
              if (owners.size > 1) {
                valid = false
                break
              }
              const required = [...owners][0]
              if (required !== undefined && required < owner) {
                valid = false
                break
              }
              if (required !== undefined && required > owner)
                seams.push({
                  from: owner,
                  to: required,
                  groupIndex,
                  head: rows[owner].at(-1),
                  tailEmpty: rows[required].length === 0
                })
              if (required !== undefined) owner = required
              const parts = group.map((token) => ({
                ...token,
                ink: token.anchor ? anchorInk(token.anchor, point) : measure(token.text, point)
              }))
              let placed = false
              while (
                owner < regions.length &&
                (required === undefined || required === owner) &&
                !placed
              ) {
                const region = regions[owner],
                  rect = region.local,
                  pageRows = rows[owner]
                // Regenerated labels may follow translated word order within this
                // paragraph's page. Native objects remain with their source region;
                // annotation indices and actions cannot move between PDF pages.
                if (
                  group.some(
                    (token) =>
                      token.anchor &&
                      regions[token.anchor.owner].fragment.pageNumber !== region.fragment.pageNumber
                  )
                ) {
                  owner++
                  continue
                }
                for (const append of pageRows.length ? [true, false] : [false]) {
                  const combined = append ? [...pageRows.at(-1).parts, ...parts] : parts
                  const width = combined.reduce((sum, part) => sum + part.ink.width, 0)
                  const top = Math.max(...combined.map((part) => part.ink.top)),
                    bottom = Math.min(...combined.map((part) => part.ink.bottom)),
                    occupiedTop = Math.max(
                      ...combined.map((part) => part.ink.occupiedTop ?? part.ink.top)
                    ),
                    occupiedBottom = Math.min(
                      ...combined.map((part) => part.ink.occupiedBottom ?? part.ink.bottom)
                    )
                  const previous = pageRows.at(append ? -2 : -1)
                  const baseline = previous
                    ? Math.min(
                        previous.baseline - point * region.lineHeight,
                        previous.occupiedBottom - occupiedTop - point * (compact ? 0.03 : 0.15)
                      )
                    : Math.min(
                        region.sourceBaseline,
                        rect.top - (reserveHitArea ? occupiedTop : top)
                      )
                  if (width > rect.width || baseline + bottom < rect.bottom) continue
                  const row = {
                    parts: combined,
                    baseline,
                    bottom: baseline + bottom,
                    occupiedBottom: baseline + occupiedBottom
                  }
                  if (append) pageRows[pageRows.length - 1] = row
                  else pageRows.push(row)
                  placed = true
                  break
                }
                if (!placed) owner++
              }
              if (!placed) {
                valid = false
                break
              }
            }
            if (!valid) return
            fitted = regions.map((region, index) => {
              const lines = []
              for (const row of rows[index]) {
                let x = region.local.x
                for (const part of row.parts) {
                  if (part.anchor) lines.push(anchorLine(part.anchor, point, x, row.baseline))
                  else {
                    const previous = lines.at(-1)
                    if (
                      previous?.text !== undefined &&
                      !previous.anchor &&
                      previous.y === row.baseline
                    )
                      previous.text += part.text
                    else lines.push({ text: part.text, x: x - part.ink.left, y: row.baseline })
                  }
                  x += part.ink.width
                }
              }
              return {
                ...region,
                point,
                lines,
                reflowed: true,
                ...(compact ? { compactLeading: true } : {})
              }
            })
            if (
              !fitted.every((region) => reflowedLinksFit(region, region.lines)) ||
              !regionsFit(fitted)
            )
              fitted = undefined
            return fitted ? { fitted, rows, seams } : undefined
          }
          const original = flowGroups(groups)
          fitted = original?.fitted
          // Keep a complete Han word with its native bracketed citation when the
          // citation's owner forces a move to the next column. Reflow at exactly
          // the already accepted font/leading, never borrowing another region.
          if (
            original &&
            regions.length === 2 &&
            unit.fragments.length === 2 &&
            regions[0].fragment.pageNumber === regions[1].fragment.pageNumber &&
            regions.every((r) => r.cos === 1 && r.sin === 0) &&
            regions[0].rect.x + regions[0].rect.width < regions[1].rect.x &&
            regions[0].fragment.rect.x + regions[0].fragment.rect.width <
              regions[1].fragment.rect.x &&
            regions[1].rect.bottom > regions[0].rect.top
          ) {
            const seam = original.seams.find((s) => s.from === 0 && s.to === 1 && s.tailEmpty),
              head = seam?.head,
              right = seam && groups[seam.groupIndex],
              first = right?.[0],
              citation = right?.[1]?.anchor,
              reference =
                citation &&
                translatedPdfBracketedReference(
                  unit.source,
                  unit.translation,
                  citation.sourceLabel ?? citation.label,
                  citation.sourceOffset
                ),
              citationOwned =
                reference &&
                reference.start === citation.targetOffset &&
                reference.targetBlock.start === citation.targetOffset - 1 &&
                [...reference.targetBlock.text.matchAll(/\d+/gu)].every((n) => {
                  const matches = anchors.filter(
                    (a) =>
                      a.targetOffset === reference.targetBlock.start + n.index && a.label === n[0]
                  )
                  return (
                    matches.length === 1 &&
                    matches[0].annotation &&
                    !matches[0].generated &&
                    matches[0].owner === 1
                  )
                })
            if (
              head?.parts.length &&
              head.parts.every((p) => p.text && !p.anchor) &&
              first?.text &&
              right[1]?.anchor?.annotation &&
              !right[1].anchor.generated &&
              right[1].anchor.owner === 1 &&
              citationOwned &&
              /^\d+$/u.test(right[1].anchor.label)
            ) {
              const headText = head.parts.map((p) => p.text).join(''),
                joined = headText + first.text,
                word = new Intl.Segmenter(undefined, { granularity: 'word' })
                  .segment(joined)
                  .containing(headText.length - 1)
              if (
                word?.isWordLike &&
                /^\p{Script=Han}{2,}$/u.test(word.segment) &&
                word.index > 0 &&
                headText.slice(0, word.index).trim() &&
                word.index < headText.length &&
                word.index + word.segment.length > headText.length &&
                /^[[(（［]$/u.test(
                  first.text.slice(word.index + word.segment.length - headText.length)
                )
              ) {
                const partial = headText.slice(word.index),
                  taken = []
                let start = seam.groupIndex
                while (start > 0 && taken.map((t) => t.text).join('').length < partial.length) {
                  const previous = groups[start - 1]
                  if (!previous.every((t) => t.text && !t.anchor)) break
                  taken.unshift(...previous)
                  start--
                }
                if (
                  taken.length <= head.parts.length &&
                  taken.map((t) => t.text).join('') === partial &&
                  head.parts.slice(-taken.length).every((p, i) => p.text === taken[i].text)
                ) {
                  const adjusted = [
                      ...groups.slice(0, start),
                      [...taken, ...right],
                      ...groups.slice(seam.groupIndex + 1)
                    ],
                    text = (list) =>
                      list
                        .flat()
                        .map((t) => t.text ?? t.anchor.label)
                        .join('')
                  if (text(adjusted) === text(groups)) {
                    const retry = flowGroups(adjusted)
                    if (
                      retry &&
                      retry.rows.every(
                        (rows, i) =>
                          rows.length === original.rows[i].length &&
                          rows.every((r, j) => r.baseline === original.rows[i][j].baseline)
                      )
                    )
                      fitted = retry.fitted
                  }
                }
              }
            }
          }
        }
      }
    }
    // A shorter translation can leave empty source rows, a stranded citation,
    // or large horizontal padding before a fixed anchor. Retry continuous inline
    // flow only for dense prose and proven available space. Compacting a nonempty
    // row additionally requires complete named citations; numeric links stay fixed.
    // Retain the verified fixed layout if its native glyphs or links cannot fit.
    const fixedFit = fitted
    if (fitted?.length === 1 && fitted[0].anchors.length) {
      const region = fitted[0]
      const sourceRows = [...region.baselines].sort((a, b) => b - a)
      const targetRows = region.lines
        .map(
          (line) =>
            line.y ?? region.anchors.find((anchor) => anchor.indices === line.indices)?.baseline
        )
        .filter(Number.isFinite)
        .sort((a, b) => b - a)
      if (
        sourceRows.length > 1 &&
        sourceRows.every(
          (y, index) => !index || sourceRows[index - 1] - y < region.sourceSize * 1.7
        ) &&
        (targetRows.some(
          (y, index) => index && targetRows[index - 1] - y > region.sourceSize * 2
        ) ||
          (region.anchors.every((anchor) => {
            const identity = pdfLinkLabelKey(anchor.sourceLabel ?? '')
            return (
              anchor.annotation &&
              !anchor.generated &&
              anchor.sourceLabel === anchor.label &&
              (identity?.startsWith('dated-') ||
                /^(?:Figure|Fig\.)\s+\d+[A-Z]?$/u.test(anchor.sourceLabel))
            )
          }) &&
            region.lines.some((line, index) => {
              const anchor = region.anchors.find((anchor) => anchor.indices === line.indices),
                previous = region.lines[index - 1]
              if (!anchor?.annotation || !previous?.text?.trim() || !Number.isFinite(previous.y))
                return false
              const descent = previous.y - anchor.baseline
              return (
                (descent >= region.sourceSize * 0.8 &&
                  descent <= region.sourceSize * 1.7 &&
                  previous.x +
                    measure(previous.text, region.point).width +
                    (anchor.nativeRowWidth ?? anchor.local.width) +
                    region.point * 0.15 <=
                    region.local.x + region.local.width) ||
                (Math.abs(descent) < 0.01 &&
                  anchor.local.x - previous.x - measure(previous.text, region.point).width >
                    region.point * 2)
              )
            }))) &&
        region.anchors.every((anchor) => anchor.movable && Number.isFinite(anchor.baseline))
      )
        fitted = undefined
    }
    // Fixed links retain publisher typography when possible. Otherwise reflow
    // their original glyph objects as indivisible inline boxes in the same region.
    // The annotation follows exactly the same translation; its action never changes.
    if (!fitted && regions.length === 1 && regions[0].anchors.length) {
      const region = regions[0],
        { anchors, local: rect } = region
      const flowable = anchors.every((anchor) => anchor.movable && Number.isFinite(anchor.baseline))
      for (const anchor of anchors) {
        const closest = region.baselines.reduce(
          (nearest, baseline) =>
            Math.abs(baseline - anchor.baseline) < Math.abs(nearest - anchor.baseline)
              ? baseline
              : nearest,
          region.sourceBaseline
        )
        const offset = anchor.baseline - closest
        anchor.rise = anchor.scriptRise ?? (anchor.nativeRowBaseline === undefined ? offset : 0)
      }
      const boundaries = [
        ...new Set([
          0,
          ...ends,
          ...anchors.flatMap((anchor) => [
            anchor.targetOffset,
            anchor.targetOffset + anchor.label.length
          ])
        ])
      ]
        .filter(
          (at) =>
            !anchors.some(
              (anchor) => at > anchor.targetOffset && at < anchor.targetOffset + anchor.label.length
            )
        )
        .sort((a, b) => a - b)
      const tokens = boundaries.slice(1).map((end, index) => {
        const start = boundaries[index],
          anchor = anchors.find((item) => item.targetOffset === start)
        return anchor ? { anchor } : { text: unit.translation.slice(start, end) }
      })
      // Keep punctuation attached across an inserted anchor boundary. Each group
      // can wrap as a whole, so a closing mark never starts the next line.
      const groups = []
      for (const token of tokens) {
        const previous = groups.at(-1)
        if (
          previous &&
          !token.anchor?.nativeFootnoteRow &&
          (/^[，。！？；：、,.;:!?）)］\]｝}》」』】”’％%]/u.test((token.text ?? '').trimStart()) ||
            /[（(［[｛{《「『【“‘]$/u.test((previous.at(-1).text ?? '').trimEnd()) ||
            (token.anchor &&
              !/[\s，,；;]$/u.test(previous.at(-1).text ?? '') &&
              // A standalone full URI may start after its introducer colon;
              // adjacent segments can also use their proven native row break.
              // Keep those boundaries instead of making one oversized box.
              !(
                (token.anchor.nativeRowWidth !== undefined &&
                  /[:：]\s*$/u.test(previous.at(-1).text ?? '')) ||
                (token.anchor.nativeRowBaseline !== undefined &&
                  previous.at(-1).anchor?.annotation?.uri === token.anchor.annotation?.uri &&
                  token.anchor.targetOffset ===
                    previous.at(-1).anchor.targetOffset + previous.at(-1).anchor.label.length &&
                  Math.abs(token.anchor.baseline - previous.at(-1).anchor.baseline) >=
                    region.sourceSize * 0.8)
              )))
        )
          previous.push(token)
        else groups.push([token])
      }
      const compactLinkedLeading =
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
          unit.translation
        ) &&
        ((/https?:\/\//u.test(unit.source) &&
          anchors.some((anchor) => /^https?:\/\//u.test(anchor.annotation?.uri ?? ''))) ||
          (anchors.every((anchor) => anchor.generated && anchor.annotation) &&
            anchors.filter((anchor) =>
              pdfLinkLabelKey(anchor.sourceLabel ?? '')?.startsWith('authors:')
            ).length >= 2)) &&
        region.baselines.length > 1 &&
        region.baselines
          .toSorted((a, b) => b - a)
          .every(
            (baseline, index, rows) =>
              !index ||
              (rows[index - 1] - baseline >= region.sourceSize * 0.8 &&
                rows[index - 1] - baseline <= region.sourceSize * 1.7)
          )
      // Try normal spacing first. Dense URL or verified author-citation paragraphs
      // can use a smaller positive row gap, with the same final ink/link checks.
      // Preserve the verified glyph-based candidate. Reserve the complete link
      // hit area only if ordinary flow fails its unchanged final checks.
      for (const reserveHitArea of [false, true]) {
        if (fitted) break
        for (const compact of compactLinkedLeading ? [false, true] : [false]) {
          if (fitted) break
          for (
            let point = region.sourceSize;
            flowable && point >= minimumPoint && !fitted;
            point = point > minimumPoint ? Math.max(minimumPoint, point - 0.5) : 0
          ) {
            // Keep link glyphs and hit areas at their original width. Only compact
            // unlinked prose, within the same limit used for short CJK table labels.
            // Retained formulas and link labels do not consume that prose budget.
            let horizontalScale = 1
            if (
              point === minimumPoint &&
              region.baselines.length === 1 &&
              unit.source.length <= 80 &&
              tokens.reduce(
                (count, token) => count + (token.anchor ? 0 : [...token.text].length),
                0
              ) <= 32 &&
              /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
                unit.translation
              )
            ) {
              const reserved = tokens.reduce(
                  (sum, token) => sum + (token.anchor ? anchorInk(token.anchor, point).width : 0),
                  0
                ),
                prose = tokens.reduce(
                  (sum, token) => sum + (token.anchor ? 0 : measure(token.text, point).width),
                  0
                ),
                scale = (rect.width - reserved - 0.02) / prose
              if (scale >= 0.85 && scale < 1) horizontalScale = scale
            }
            const measureProse = (text) => {
              const ink = measure(text, point)
              return {
                ...ink,
                left: ink.left * horizontalScale,
                width: ink.width * horizontalScale
              }
            }
            const rows = [[]]
            let width = 0,
              valid = true
            for (const group of groups) {
              const parts = group.map((token) => ({
                ...token,
                ink: token.anchor ? anchorInk(token.anchor, point) : measureProse(token.text)
              }))
              const groupWidth = parts.reduce((sum, part) => sum + part.ink.width, 0)
              // Normalized PDF coordinates can round an exact fit below its
              // measured width by a few ulps. Final ink/link checks still apply.
              if (groupWidth > rect.width + 1e-6) {
                valid = false
                break
              }
              if (width + groupWidth > rect.width + 1e-6 && rows.at(-1).length) {
                rows.push([])
                width = 0
              }
              for (const part of parts) {
                const row = rows.at(-1),
                  last = row.at(-1)
                if (last?.text !== undefined && part.text !== undefined) {
                  const combined = measureProse(last.text + part.text)
                  last.text += part.text
                  width += combined.width - last.ink.width
                  last.ink = combined
                } else {
                  row.push({ ...part, x: rect.x + width })
                  width += part.ink.width
                }
              }
              if (width > rect.width + 1e-6) {
                valid = false
                break
              }
            }
            const lines = []
            let baseline, previousBottom, firstTop, lastBottom
            for (const row of valid ? rows : []) {
              const top = Math.max(...row.map((part) => part.ink.top)),
                bottom = Math.min(...row.map((part) => part.ink.bottom)),
                occupiedTop = Math.max(...row.map((part) => part.ink.occupiedTop ?? part.ink.top)),
                occupiedBottom = Math.min(
                  ...row.map((part) => part.ink.occupiedBottom ?? part.ink.bottom)
                )
              baseline =
                baseline === undefined
                  ? Math.max(
                      rect.bottom - (reserveHitArea ? occupiedBottom : bottom),
                      Math.min(
                        region.sourceBaseline,
                        rect.top - (reserveHitArea ? occupiedTop : top)
                      )
                    )
                  : Math.min(
                      baseline - point * region.lineHeight,
                      previousBottom - occupiedTop - point * (compact ? 0.03 : 0.15)
                    )
              firstTop ??= baseline + occupiedTop
              lastBottom = baseline + bottom
              if (baseline + top > rect.top) {
                valid = false
                break
              }
              for (const part of row) {
                if (part.anchor) lines.push(anchorLine(part.anchor, point, part.x, baseline))
                else
                  lines.push({
                    text: part.text,
                    x: part.x - part.ink.left,
                    y: baseline,
                    horizontalScale
                  })
              }
              previousBottom = baseline + occupiedBottom
            }
            // Borrowed whitespace can be above the original baseline. Lift the whole
            // fitted block only as much as needed, keeping every anchor with its row.
            const lift = Math.max(0, rect.bottom - lastBottom)
            if (valid && lines.length && (!lift || firstTop + lift <= rect.top)) {
              if (lift)
                for (const line of lines) {
                  if (line.y !== undefined) line.y += lift
                  if (line.dy !== undefined) line.dy += lift
                }
              if (reflowedLinksFit(region, lines))
                fitted = [
                  {
                    ...region,
                    point,
                    lines,
                    reflowed: true,
                    ...(compact ? { compactLeading: true } : {})
                  }
                ]
            }
          }
        }
      }
    }
    fitted ??= fixedFit
    // Compact one-line CJK labels can be slightly wider than an abbreviated
    // source cell. Use at most 15% horizontal condensation at the readable-size
    // floor; do not move a link, change line height, or enlarge the source cell.
    if (
      !fitted &&
      regions.length === 1 &&
      !regions[0].anchors.length &&
      regions[0].baselines.length === 1 &&
      unit.source.length <= 80 &&
      [...unit.translation].length <= 32 &&
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
        unit.translation
      )
    ) {
      const region = regions[0],
        rect = region.local,
        point = minimumPoint,
        ink = measure(unit.translation, point),
        horizontalScale = (rect.width - 0.02) / ink.width,
        y = Math.min(region.sourceBaseline, rect.top - ink.top)
      if (horizontalScale >= 0.85 && horizontalScale < 1 && y + ink.bottom >= rect.bottom)
        fitted = [
          {
            ...region,
            point,
            lines: [
              { text: unit.translation, x: rect.x - ink.left * horizontalScale, y, horizontalScale }
            ]
          }
        ]
      // A short expanded label may have one extra owned line. Try the same
      // bounded condensation only after ordinary wrapping and one-line fitting;
      // keep scientific tokens whole and every glyph inside the source cell.
      for (const scale of fitted || !/^[A-Z]+\d+$/u.test(unit.source.trim())
        ? []
        : [0.95, 0.9, 0.85]) {
        const lines = []
        let start = 0
        while (start < unit.translation.length && lines.length < 2) {
          let stop = start,
            next
          for (const end of ends) {
            if (end <= start) continue
            const candidate = measure(unit.translation.slice(start, end), point)
            if (candidate.width * scale > rect.width - 0.02) break
            stop = end
            next = candidate
          }
          if (stop === start) break
          let baseline = lines.length
            ? lines.at(-1).y - point * region.lineHeight
            : Math.min(region.sourceBaseline, rect.top - next.top)
          const lift = Math.max(0, rect.bottom - baseline - next.bottom)
          if (lift) {
            if (
              baseline + lift + next.top > rect.top ||
              lines.some((line) => line.y + lift + measure(line.text, point).top > rect.top)
            )
              break
            for (const line of lines) line.y += lift
            baseline += lift
          }
          lines.push({
            text: unit.translation.slice(start, stop),
            x: rect.x - next.left * scale,
            y: baseline,
            horizontalScale: scale
          })
          start = stop
        }
        if (start === unit.translation.length && lines.length === 2) {
          const candidate = [{ ...region, point, lines }]
          if (regionsFit(candidate)) {
            fitted = candidate
            break
          }
        }
      }
    }
    check(
      fitted,
      overlappingCandidate
        ? preserveUnsupported
          ? 'unsupported-layout'
          : 'multi-region'
        : 'overflow'
    )
    // Repair only a dictionary word split across adjacent physical prose regions.
    for (let index = 1; index < fitted.length; index++) {
      const head = fitted[index - 1],
        tail = fitted[index],
        last = head.lines.at(-1),
        first = tail.lines[0]
      if (
        !last?.text ||
        !first?.text ||
        head.fragment.pageNumber !== tail.fragment.pageNumber ||
        head.point !== tail.point ||
        ![head, tail].every((r) => r.cos === 1 && r.sin === 0) ||
        head.rect.bottom < tail.rect.top ||
        head.rect.bottom - tail.rect.top > head.point * 0.5 ||
        Math.min(head.rect.x + head.rect.width, tail.rect.x + tail.rect.width) <=
          Math.max(head.rect.x, tail.rect.x) ||
        last.y - first.y < head.point * 0.7 ||
        last.y - first.y > head.point * 2 ||
        ![...head.lines, ...tail.lines].every(
          (l) =>
            l.text &&
            !l.anchor &&
            !l.indices &&
            !l.rect &&
            l.point === undefined &&
            l.horizontalScale === undefined &&
            Number.isFinite(l.x) &&
            Number.isFinite(l.y)
        ) ||
        head.lines.slice(0, -1).some((l) => Math.abs(l.y - last.y) < head.point * 0.5) ||
        tail.lines.slice(1).some((l) => Math.abs(l.y - first.y) < tail.point * 0.5)
      )
        continue
      const joined = last.text + first.text,
        word = new Intl.Segmenter(undefined, { granularity: 'word' })
          .segment(joined)
          .containing(last.text.length - 1)
      if (
        !word?.isWordLike ||
        !/^\p{Script=Han}{2,}$/u.test(word.segment) ||
        word.index >= last.text.length ||
        word.index + word.segment.length <= last.text.length
      )
        continue
      const prefix = last.text.slice(0, word.index),
        continuation = last.text.slice(word.index) + first.text
      if (!prefix.trim() || prefix + continuation !== joined) continue
      const inks = [measure(prefix, head.point), measure(continuation, tail.point)],
        moved = [last, first].map((line, i) => ({
          ...line,
          text: i ? continuation : prefix,
          x: line.x + measure(line.text, head.point).left - inks[i].left
        }))
      if (
        moved.some((line, i) => {
          const r = i ? tail : head,
            ink = inks[i]
          return (
            line.x + ink.left < r.local.x ||
            line.x + ink.left + ink.width > r.local.x + r.local.width ||
            line.y + ink.top > r.local.top ||
            line.y + ink.bottom < r.local.bottom
          )
        })
      )
        continue
      const candidate = fitted.slice()
      candidate[index - 1] = { ...head, lines: [...head.lines.slice(0, -1), moved[0]] }
      candidate[index] = { ...tail, lines: [moved[1], ...tail.lines.slice(1)] }
      if (regionsFit(candidate)) fitted = candidate
    }

    // Keep a short cross-page tail with its preceding clause when both rows are
    // unanchored prose. Never move native objects, resize text, or borrow space.
    const previous = fitted.at(-2),
      tail = fitted.at(-1),
      last = previous?.lines.at(-1),
      first = tail?.lines[0]
    // A same-page column continuation may leave only a short prose tail after a
    // lowered script. Keep every fixed run in place; only its following comma
    // clause can move to the next column's original rectangle.
    const columnHeadLeft = (() => {
      if (
        fitted.length !== 2 ||
        unit.fragments.length !== 2 ||
        !last?.text ||
        !first?.text ||
        previous.fragment.pageNumber !== tail.fragment.pageNumber ||
        previous.fragment.rect.x + previous.fragment.rect.width >= tail.fragment.rect.x ||
        previous.rect.x + previous.rect.width >= tail.rect.x ||
        tail.rect.bottom <= previous.rect.top ||
        previous.point !== tail.point ||
        ![previous, tail].every((region) => region.cos === 1 && region.sin === 0)
      )
        return null
      const fixed = previous.lines.slice(0, -1),
        inkLeft = last.x + measure(last.text, previous.point).left
      let left = inkLeft,
        lowered = false
      for (const [index, line] of fixed.entries()) {
        const baseline = line.anchor ? line.anchor.baseline + line.dy - line.anchor.rise : line.y
        if (!Number.isFinite(baseline)) return null
        if (Math.abs(baseline - last.y) >= previous.point * 0.5) continue
        if (!line.text || line.indices || line.rect || line.horizontalScale !== undefined)
          return null
        if (line.anchor) {
          const anchor = line.anchor,
            base = fixed[index - 1],
            letter = unit.source[anchor.sourceOffset - 1]
          if (
            !anchor.generated ||
            anchor.annotation ||
            !Number.isFinite(anchor.scriptRise) ||
            !Number.isFinite(anchor.scale) ||
            anchor.scriptRise >= -0.1 ||
            anchor.scale < 0.5 ||
            anchor.scale >= 0.9 ||
            !/^[A-Za-z\p{Script=Greek}]$/u.test(letter ?? '') ||
            unit.translation[anchor.targetOffset - 1] !== letter ||
            !/^[A-Za-z\p{Script=Greek}\d]$/u.test(anchor.label) ||
            !base?.text?.endsWith(letter) ||
            base.anchor ||
            base.indices ||
            base.rect ||
            Math.abs(base.y - last.y) > 0.001 ||
            !Number.isFinite(line.point) ||
            line.point >= previous.point ||
            Math.abs(line.y - base.y - anchor.scriptRise) > 0.001
          )
            return null
          lowered = true
        } else if (line.point !== undefined || Math.abs(line.y - last.y) > 0.001) return null
        const ink = measure(line.text, line.point ?? previous.point),
          start = line.x + ink.left,
          end = start + ink.width
        if (
          ![start, end, line.y].every(Number.isFinite) ||
          start < previous.local.x ||
          end > inkLeft + 0.001 ||
          line.y + ink.top > previous.local.top ||
          line.y + ink.bottom < previous.local.bottom
        )
          return null
        left = Math.min(left, start)
      }
      return lowered ? left : null
    })()
    if (
      previous &&
      (tail.fragment.pageNumber === previous.fragment.pageNumber + 1 || columnHeadLeft !== null) &&
      tail.lines.length === 1 &&
      previous.point === tail.point &&
      [previous, tail].every((region) => region.cos === 1 && region.sin === 0) &&
      [last, first].every(
        (line) =>
          line?.text &&
          !line.anchor &&
          !line.indices &&
          !line.rect &&
          line.point === undefined &&
          line.horizontalScale === undefined
      ) &&
      (columnHeadLeft !== null ||
        !previous.lines.slice(0, -1).some((line) => {
          const baseline = line.anchor ? line.anchor.baseline + line.dy - line.anchor.rise : line.y
          return !Number.isFinite(baseline) || Math.abs(baseline - last.y) < previous.point * 0.5
        })) &&
      measure(first.text, tail.point).width < tail.local.width * 0.25
    ) {
      // ASCII periods are deliberately excluded: decimal points and abbreviations
      // are not proven sentence boundaries. Preserve every character, including spaces.
      const boundaries = [
        ...last.text.matchAll(
          columnHeadLeft !== null ? /，|,(?=\s)/gu : /[，。；！？]|[;,!?](?=\s)/gu
        )
      ].reverse()
      for (const boundary of boundaries) {
        const at = boundary.index + boundary[0].length
        if (!pdfTranslationLineEnds(last.text).includes(at)) continue
        const prefix = last.text.slice(0, at),
          continuation = last.text.slice(at) + first.text,
          headInk = measure(prefix, previous.point),
          tailInk = measure(continuation, tail.point)
        if (
          !last.text.slice(at).trim() ||
          (columnHeadLeft === null
            ? headInk.width
            : last.x + measure(last.text, previous.point).left + headInk.width - columnHeadLeft) <
            previous.local.width * 0.25 ||
          tailInk.width < tail.local.width * 0.25 ||
          tailInk.width > tail.local.width
        )
          continue
        if (prefix + continuation !== last.text + first.text) continue
        const moved = [
          {
            ...last,
            text: prefix,
            x: last.x + measure(last.text, previous.point).left - headInk.left
          },
          {
            ...first,
            text: continuation,
            x: first.x + measure(first.text, tail.point).left - tailInk.left
          }
        ]
        if (
          moved.some((line, index) => {
            const region = index ? tail : previous,
              ink = index ? tailInk : headInk
            return (
              line.x + ink.left < region.local.x ||
              line.x + ink.left + ink.width > region.local.x + region.local.width ||
              line.y + ink.top > region.local.top ||
              line.y + ink.bottom < region.local.bottom
            )
          })
        )
          continue
        const candidate = fitted.slice()
        candidate[candidate.length - 2] = {
          ...previous,
          lines: [...previous.lines.slice(0, -1), moved[0]]
        }
        candidate[candidate.length - 1] = { ...tail, lines: [moved[1]] }
        if (regionsFit(candidate)) fitted = candidate
        break
      }
    }
    check(regionsFit(fitted), preserveUnsupported ? 'unsupported-layout' : 'multi-region')
    for (const region of fitted) {
      region.lines = region.lines.flatMap((line) => {
        if (line.indices) return [line]
        const runs = []
        for (const char of line.text) {
          const fontIndex = fontForCharacter.get(char) ?? 0,
            previous = runs.at(-1)
          if (previous?.fontIndex === fontIndex) previous.text += char
          else runs.push({ text: char, fontIndex })
        }
        check(!line.anchor || runs.length === 1, 'annotations')
        let x = line.x
        return runs.map((run) => {
          const font = fonts[run.fontIndex],
            value = { ...line, ...run, x, encoded: font.encodeText(run.text).asBytes() }
          x +=
            font.widthOfTextAtSize(run.text, line.point ?? region.point) *
            (line.horizontalScale ?? 1)
          return value
        })
      })
    }
    plans.push(...fitted.map((region) => ({ ...region, unit: originalUnit })))
  }
  try {
    for (const unit of units) {
      try {
        planUnit(unit)
      } catch (error) {
        // Retry only this region as unchanged, through the same source/geometry preflight.
        // Invalid input and failures after page mutation still fail closed.
        const canPreserveOriginal =
          unit.fragments.length > 2 || /^[\d\s,.;:–—-]+$/u.test(unit.source.trim())
        if (
          !preserveUnsupported ||
          !['annotations', 'overflow', 'unsupported-layout', 'source-mismatch', 'font'].includes(
            error.failure?.code
          )
        )
          throw error
        // A table cell may occupy only part of a native text object. Verify its
        // bounded text before preserving it; a mismatched source still fails below.
        try {
          planUnit({ ...unit, translation: unit.source })
        } catch (fallbackError) {
          // Some publishers split one paragraph into multiple linked fragments;
          // PDFium cannot verify that aggregate as one unchanged region. Leave that
          // region untouched while retaining strict source checks for single regions.
          if (fallbackError.failure?.code !== 'source-mismatch' || !canPreserveOriginal)
            throw fallbackError
          retainRegions(unit)
        }
        diagnoseRetention(unit, error.failure.code, 'planning')
      }
    }
  } finally {
    closePlanningPage()
  }
  if (preserveUnsupported) {
    // Dense table rows may have overlapping extraction boxes. Keep both complete
    // verified units when their output regions overlap, even if both were translated;
    // do this before page mutation, including every fragment of a joined unit.
    let retained
    do {
      retained = new Set()
      for (const plan of plans) {
        if (plan.unchanged) continue
        if (plans.some((other) => other !== plan && regionsOverlap(other, plan)))
          retained.add(plan.unit)
      }
      for (const plan of plans)
        if (retained.has(plan.unit)) {
          plan.unchanged = true
          diagnoseRetention(plan.unit, 'multi-region', 'ownership')
        }
    } while (retained.size)
  }
  try {
    const borrowedPages = []
    try {
      // Preflight every source object before deleting any. Ambiguous partial objects fail closed.
      const used = new Set()
      for (let i = 0; i < pages.length; i++) {
        if (selectedPages && !selectedPages.has(i + 1)) continue
        pageNumber = i + 1
        const page = p.FPDF_LoadPage(input.doc, i)
        check(page)
        borrowedPages.push(page)
        const objects = e.objects(page)
        const { sources: overprintedSources } = recoverOverprintedTextSources(e, page, objects)
        for (const object of objects)
          object.text = overprintedSources.get(object.obj) ?? object.text
        applyActualTextSources(i + 1, objects)
        const occupied = []
        for (const plan of plans.filter((plan) => plan.fragment.pageNumber === i + 1)) {
          const { rect } = plan
          check(
            occupied.every(
              (other) => (other.unchanged && plan.unchanged) || !regionsOverlap(other, plan)
            ),
            'multi-region'
          )
          occupied.push(plan)
          if (plan.unchanged) continue
          const touched = objects.filter(
            (o) =>
              o.type === 1 &&
              o.bounds[0] < rect.x + rect.width &&
              o.bounds[2] > rect.x &&
              o.bounds[1] < rect.top &&
              o.bounds[3] > rect.bottom
          )
          check(
            touched.length > 0 &&
              touched.every(
                (o) =>
                  o.bounds[0] >= rect.x - objectTolerance &&
                  o.bounds[2] <= rect.x + rect.width + objectTolerance &&
                  o.bounds[3] <= rect.top + objectTolerance &&
                  o.bounds[1] >= rect.bottom - objectTolerance
              )
          )
          check(
            sourceMatches(
              plan.sourceVerification ?? plan.source,
              touched
                .map((o, index) =>
                  plan.sourceVerificationPrefix && index === 0
                    ? o.text.slice(plan.sourceVerificationPrefix.length)
                    : o.text
                )
                .join('')
            ),
            'source-mismatch'
          )
          const ownedGraphics = objects.filter((object) =>
            plan.anchors.some((anchor) => anchor.graphicIndices?.includes(object.i))
          )
          check(
            !overlapsGraphic(
              page,
              objects,
              plan.fragment,
              rect,
              ownedGraphics.map((object) => object.i),
              plan.sourceInk
            )
          )
          for (const o of touched) {
            // A wider text object must not delete an unchanged fragment, even if
            // the caller supplied disjoint rectangles for two parts of that object.
            check(
              !plans.some(
                (other) =>
                  other.unchanged &&
                  (!other.verifiedObjects || other.objectIndices.includes(o.i)) &&
                  other.fragment.pageNumber === i + 1 &&
                  o.bounds[0] < other.rect.x + other.rect.width &&
                  o.bounds[2] > other.rect.x &&
                  o.bounds[1] < other.rect.top &&
                  o.bounds[3] > other.rect.bottom
              )
            )
            check(!used.has(o.obj))
            used.add(o.obj)
          }
          if (plan.anchors.length)
            check(
              plan.anchors.every((anchor) =>
                anchor.indices.every((index) =>
                  [...touched, ...ownedGraphics].some((o) => o.i === index)
                )
              ),
              'annotations'
            )
          for (const object of ownedGraphics) {
            check(!used.has(object.obj))
            used.add(object.obj)
          }
          plan.selected = [...touched, ...ownedGraphics].sort((a, b) => a.i - b.i)
          plan.page = page
        }
      }
      const replacements = plans.filter((plan) => !plan.unchanged)
      if (!replacements.length) {
        const output = annotationsRemoved ? e.save(input.doc) : data.slice()
        check(output.length <= 64 * 1024 ** 2)
        return output
      }
      const source = e.open(await carrier.save())
      try {
        check(p.FPDF_ImportPages(input.doc, source.doc, '1', pages.length))
      } finally {
        source.close()
      }
      // Use the same PDFium construction and validation before and during insertion.
      // Preflight owns temporary objects; pages and original annotations remain untouched.
      const prepareLine = (plan, line, fontHandle, painted, anchors) => {
        const codes = Buffer.alloc(line.encoded.length * 2)
        for (let i = 0; i < line.encoded.length; i += 2)
          codes.writeUInt32LE(line.encoded[i] * 256 + line.encoded[i + 1], i * 2)
        const obj = p.FPDFPageObj_CreateTextObj(input.doc, fontHandle, line.point ?? plan.point),
          ptr = e.bytes(codes)
        check(obj)
        try {
          try {
            check(p.FPDFText_SetCharcodes(obj, ptr, line.encoded.length / 2))
          } finally {
            e.free(ptr)
          }
          check(p.FPDFPageObj_SetFillColor(obj, ...plan.color))
          p.FPDFPageObj_Transform(
            obj,
            plan.cos * (line.horizontalScale ?? 1),
            plan.sin * (line.horizontalScale ?? 1),
            -plan.sin,
            plan.cos,
            plan.cos * line.x - plan.sin * line.y,
            plan.sin * line.x + plan.cos * line.y
          )
          const limit = line.rect ?? plan.rect
          let [left, bottom, right, top] = e.bounds(obj)
          // Fit against actual native font metrics when they exceed fontkit's
          // outline estimate. Scale prose uniformly, never below the layout's
          // readable-size floor or independently from a preserved link anchor.
          if (right - left > limit.width + 0.001 || top - bottom > limit.height + 0.001) {
            const scale = Math.min(
              1,
              (limit.width - 0.001) / (right - left),
              (limit.height - 0.001) / (top - bottom)
            )
            check(!line.anchor && (line.point ?? plan.point) * scale >= plan.minimumPoint)
            const x = plan.cos * line.x - plan.sin * line.y,
              y = plan.sin * line.x + plan.cos * line.y
            p.FPDFPageObj_Transform(obj, scale, 0, 0, scale, x * (1 - scale), y * (1 - scale))
            ;[left, bottom, right, top] = e.bounds(obj)
          }
          // Keep the original baseline where possible, then move only enough to
          // stay inside the admitted box. Native ink and overlap checks remain exact.
          check(right - left <= limit.width + 0.001 && top - bottom <= limit.height + 0.001)
          const dx = Math.min(Math.max(0, limit.x - left), limit.x + limit.width - right)
          const dy = Math.min(Math.max(0, limit.bottom - bottom), limit.top - top)
          if (dx || dy) p.FPDFPageObj_Transform(obj, 1, 0, 0, 1, dx, dy)
          let final = e.bounds(obj)
          // PDFium and fontkit can disagree by a fraction of a point on CJK ink
          // height. Use spare space in this line's admitted box before rejecting
          // the paragraph; never loosen the final bounds or overlap checks.
          const preceding = painted.filter(
            (box) =>
              box[3] > final[3] && box[0] < final[2] && box[2] > final[0] && box[1] < final[3]
          )
          if (preceding.length) {
            const shift = Math.min(...preceding.map((box) => box[1] - final[3] - 0.01))
            if (
              shift >= -Math.min(0.5, (line.point ?? plan.point) * 0.05) &&
              final[1] + shift >= limit.bottom &&
              final[3] + shift <= limit.top
            ) {
              p.FPDFPageObj_Transform(obj, 1, 0, 0, 1, 0, shift)
              final = e.bounds(obj)
            }
          }
          check(
            anchors.every(
              (anchor) =>
                final[0] >= anchor.link.right - 0.001 ||
                final[2] <= anchor.link.left + 0.001 ||
                final[1] >= anchor.link.top - 0.001 ||
                final[3] <= anchor.link.bottom + 0.001
            )
          )
          check(
            painted.every(
              (box) =>
                final[0] >= box[2] - 0.001 ||
                final[2] <= box[0] + 0.001 ||
                final[1] >= box[3] - 0.001 ||
                final[3] <= box[1] + 0.001
            )
          )
          if (plan.compactLeading) {
            const localInk = (box) => {
              const corners = [
                [box[0], box[1]],
                [box[0], box[3]],
                [box[2], box[1]],
                [box[2], box[3]]
              ].map(([x, y]) => -plan.sin * x + plan.cos * y)
              return { bottom: Math.min(...corners), top: Math.max(...corners) }
            }
            const ink = localInk(final),
              // Regenerated labels are centered in the publisher's click box.
              // Their glyph baseline can differ from the shared prose row;
              // horizontal ink/link collisions were checked independently above.
              rowBaseline = line.anchor ? line.dy + line.anchor.baseline - line.anchor.rise : line.y
            check(
              painted.every((box) => {
                if (Math.abs(box.rowBaseline - rowBaseline) < 0.001) return true
                const previous = localInk(box)
                return rowBaseline > box.rowBaseline
                  ? ink.bottom - previous.top >= 0.01
                  : previous.bottom - ink.top >= 0.01
              })
            )
            final.rowBaseline = rowBaseline
          }
          painted.push(final)
          return obj
        } catch (error) {
          p.FPDFPageObj_Destroy(obj)
          throw error
        }
      }
      const fontPage = p.FPDF_LoadPage(input.doc, pages.length),
        prepared = new Set()
      try {
        const fontHandles = e
          .objects(fontPage)
          .filter((o) => o.type === 1)
          .map((o) => p.FPDFTextObj_GetFont(o.obj))
        check(fontHandles.length === fonts.length && fontHandles.every(Boolean))
        const rejected = new Set()
        for (const plan of replacements) {
          pageNumber = plan.fragment.pageNumber
          if (rejected.has(plan.unit)) continue
          // Validate annotation movement before creating replacement objects. If a
          // translated line would move a link outside its source region, keep the
          // whole unit in the original language instead of failing after page
          // objects have already been removed.
          try {
            for (const line of plan.lines.filter((line) => line.anchor)) {
              const { anchor } = line
              if (anchor.generated && !anchor.annotation) continue
              const dx = plan.cos * line.dx - plan.sin * line.dy,
                dy = plan.sin * line.dx + plan.cos * line.dy,
                link = {
                  left: anchor.link.left + dx,
                  right: anchor.link.right + dx,
                  bottom: anchor.link.bottom + dy,
                  top: anchor.link.top + dy
                }
              check(linkFits(plan.rect, anchor, link), 'annotations')
              for (const annotation of anchor.annotation
                ? [anchor.annotation, ...(anchor.additionalAnnotations ?? [])]
                : []) {
                const annot = p.FPDFPage_GetAnnot(plan.page, annotation.index)
                try {
                  check(annot, 'annotations')
                } finally {
                  if (annot) p.FPDFPage_CloseAnnot(annot)
                }
              }
            }
          } catch (error) {
            if (!preserveUnsupported || error.failure?.code !== 'annotations') throw error
            rejected.add(plan.unit)
            diagnoseRetention(plan.unit, error.failure.code, 'glyphs')
            continue
          }
          // Validate against the future positions of any retained/reflowed links.
          const positionedAnchors = plan.reflowed
            ? plan.lines.flatMap((line) => (line.anchor ? [line.anchor] : []))
            : plan.anchors
          const anchors = positionedAnchors.map((anchor) => {
            const line = plan.lines.find((line) => line.anchor === anchor)
            if (!line) return anchor
            const dx = plan.cos * line.dx - plan.sin * line.dy,
              dy = plan.sin * line.dx + plan.cos * line.dy
            return {
              link: {
                left: anchor.link.left + dx,
                right: anchor.link.right + dx,
                bottom: anchor.link.bottom + dy,
                top: anchor.link.top + dy
              }
            }
          })
          const painted = []
          try {
            for (const line of plan.lines) {
              if (line.indices) continue
              line.object = prepareLine(
                plan,
                line,
                fontHandles[line.fontIndex],
                painted,
                anchors.filter(
                  (_, index) =>
                    positionedAnchors[index] !== line.anchor &&
                    !(positionedAnchors[index].generated && !positionedAnchors[index].annotation)
                )
              )
              prepared.add(line.object)
            }
          } catch (error) {
            if (
              !preserveUnsupported ||
              !['annotations', 'unsupported-layout'].includes(error.failure?.code)
            )
              throw error
            rejected.add(plan.unit)
            diagnoseRetention(plan.unit, error.failure.code, 'glyphs')
          }
        }
        // Retain every fragment of a unit if any replacement cannot fit. All original
        // regions were already independently verified before this glyph preflight.
        for (const plan of replacements) if (rejected.has(plan.unit)) plan.unchanged = true
        // Paint-order lookup needs only current object identity. Re-extracting
        // every glyph on each insertion repeatedly reparses the growing page.
        const objectIndex = (page, object) => {
          const count = p.FPDFPage_CountObjects(page)
          for (let index = 0; index < count; index++)
            if (p.FPDFPage_GetObject(page, index) === object) return index
          return -1
        }
        for (const plan of replacements.filter((plan) => !plan.unchanged)) {
          pageNumber = plan.fragment.pageNumber
          const insertAt = objectIndex(plan.page, plan.selected[0].obj)
          check(insertAt >= 0)
          const reordered =
            plan.reflowed &&
            (plan.anchors.some((anchor) => anchor.generated) ||
              plan.lines
                .filter((line) => line.anchor)
                .some((line, index) => line.anchor !== plan.anchors[index]))
          for (const o of plan.selected) {
            if (plan.zeroInkIndices?.includes(o.i)) continue
            // Keep the original anchor in the page, including its paint order
            // relative to non-text objects. Only the surrounding prose is replaced.
            const retained = plan.anchors.some(
              (anchor) => !anchor.generated && anchor.indices.includes(o.i)
            )
            if (retained && !reordered) continue
            check(p.FPDFPage_RemoveObject(plan.page, o.obj))
            if (!retained) p.FPDFPageObj_Destroy(o.obj)
          }
          if (plan.reflowed) {
            for (const line of plan.lines.filter((line) => line.anchor)) {
              const { anchor } = line
              if (anchor.generated && !anchor.annotation) continue
              const dx = plan.cos * line.dx - plan.sin * line.dy,
                dy = plan.sin * line.dx + plan.cos * line.dy
              for (const index of anchor.generated ? [] : anchor.indices) {
                const object = plan.selected.find((item) => item.i === index).obj
                p.FPDFPageObj_Transform(object, 1, 0, 0, 1, dx, dy)
              }
              anchor.link = {
                ...anchor.link,
                left: anchor.link.left + dx,
                right: anchor.link.right + dx,
                bottom: anchor.link.bottom + dy,
                top: anchor.link.top + dy
              }
              check(linkFits(plan.rect, anchor, anchor.link), 'annotations')
              for (const old of anchor.annotation
                ? [anchor.annotation, ...(anchor.additionalAnnotations ?? [])]
                : []) {
                const annot = p.FPDFPage_GetAnnot(plan.page, old.index),
                  at = e.alloc(16)
                try {
                  check(annot, 'annotations')
                  e.m.HEAPF32.set(
                    [old.left + dx, old.top + dy, old.right + dx, old.bottom + dy],
                    at / 4
                  )
                  check(p.FPDFAnnot_SetRect(annot, at), 'annotations')
                } finally {
                  e.free(at)
                  if (annot) p.FPDFPage_CloseAnnot(annot)
                }
              }
            }
          }
          const anchorPosition = (index) =>
            objectIndex(plan.page, plan.selected.find((selected) => selected.i === index)?.obj)
          let insertion =
            plan.anchors.length && !reordered
              ? anchorPosition(plan.anchors[0].indices[0])
              : insertAt
          check(insertion >= 0)
          for (const line of plan.lines) {
            if (line.indices) {
              if (reordered) {
                // PDF text extraction follows content order. Move retained glyphs
                // in that order too when a translated sentence moves A0/A1/etc.
                for (const index of line.indices)
                  check(
                    p.FPDFPage_InsertObjectAtIndex(
                      plan.page,
                      plan.selected.find((object) => object.i === index).obj,
                      insertion++
                    )
                  )
                continue
              }
              const end = anchorPosition(line.indices.at(-1))
              check(end >= 0)
              insertion = end + 1
              continue
            }
            // Transfer the already-validated object to the page without rebuilding it.
            check(prepared.has(line.object))
            check(p.FPDFPage_InsertObjectAtIndex(plan.page, line.object, insertion++))
            prepared.delete(line.object)
          }
        }
        for (const page of new Set(replacements.map((plan) => plan.page)))
          check(p.FPDFPage_GenerateContent(page))
      } finally {
        // Rejected units and failed insertions still own their uninserted objects.
        for (const object of prepared) p.FPDFPageObj_Destroy(object)
        p.FPDF_ClosePage(fontPage)
        p.FPDFPage_Delete(input.doc, pages.length)
      }
    } finally {
      for (const page of borrowedPages) p.FPDF_ClosePage(page)
    }
    const saveStarted = performance.now()
    const output = e.save(input.doc)
    timings.pdfiumSaveMs += performance.now() - saveStarted
    check(output.length <= 64 * 1024 ** 2)
    return output
  } finally {
    input.close()
  }
}
// Keep the original page tree/catalog of the verified baseline. Copying pages into
// a new document would strand internal GoTo links and named destinations. Redirect
// donor page references through the public copier before copying their contents.
async function replaceChangedPages(baselineData, changedData, pageNumbers, count) {
  const baseline = await PDFDocument.load(baselineData, { updateMetadata: false }),
    changed = await PDFDocument.load(changedData, { updateMetadata: false }),
    before = baseline.getPages(),
    after = changed.getPages()
  check(before.length === count && after.length === count, 'invalid-input')
  const pageRefs = new Map(after.map((page, index) => [page.ref, before[index].ref])),
    copier = PDFObjectCopier.for(changed.context, baseline.context),
    copy = copier.copy
  copier.copy = (object) => pageRefs.get(object) ?? copy(object)
  for (const number of pageNumbers) {
    pageNumber = number
    const source = after[number - 1].node,
      target = before[number - 1].node,
      parent = target.get(PDFName.of('Parent'))
    // A fresh dictionary prevents shared inherited resources from being mutated.
    for (const [key] of target.entries()) if (key.toString() !== '/Parent') target.delete(key)
    for (const [key, value] of source.entries())
      if (key.toString() !== '/Parent') target.set(key, copier.copy(value))
    for (const name of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const key = PDFName.of(name),
        value = source.getInheritableAttribute(key)
      if (!target.has(key) && value) target.set(key, copier.copy(value))
    }
    if (parent) target.set(PDFName.of('Parent'), parent)
  }
  // Repeated updates must not retain superseded page streams/font subsets. Only
  // unreachable objects are removed; the catalog retains bookmarks and names.
  const visited = new Set(),
    reachable = new Set(),
    visit = (object) => {
      if (!object || visited.has(object)) return
      visited.add(object)
      if (object instanceof PDFRef) {
        reachable.add(object)
        visit(baseline.context.lookup(object))
      } else if (object instanceof PDFStream) visit(object.dict)
      else if (object instanceof PDFDict) for (const [, value] of object.entries()) visit(value)
      else if (object instanceof PDFArray) for (const value of object.asArray()) visit(value)
    }
  for (const value of Object.values(baseline.context.trailerInfo)) visit(value)
  for (const [ref] of baseline.context.enumerateIndirectObjects())
    if (!reachable.has(ref)) baseline.context.delete(ref)
  const saveStarted = performance.now()
  const output = await baseline.save()
  timings.mergeSaveMs += performance.now() - saveStarted
  return output
}
try {
  const selectedPages = workerData.incremental
    ? new Set(workerData.incremental.pageNumbers)
    : undefined
  const units = selectedPages
    ? workerData.units.filter((unit) =>
        unit.fragments.some((fragment) => selectedPages.has(fragment.pageNumber))
      )
    : workerData.units
  const generationStarted = performance.now()
  const generated = await generate({ ...workerData, units, selectedPages })
  timings.generationMs = performance.now() - generationStarted
  const labelsStarted = performance.now()
  const formFailures = new Map()
  let data = workerData.preserveUnsupported
    ? await translateFormLabels(generated, units, workerData.pages, generate, (unit, localUnit) => {
        formFailures.set(unit, formFailures.get(unit) ?? retainedUnitObjects.get(localUnit))
      })
    : generated
  timings.formLabelsMs = performance.now() - labelsStarted
  if (workerData.incremental) {
    const mergeStarted = performance.now()
    data = await replaceChangedPages(
      workerData.incremental.data,
      data,
      workerData.incremental.pageNumbers,
      workerData.pages.length
    )
    timings.mergeMs = performance.now() - mergeStarted
  }
  check(data.length <= 64 * 1024 ** 2)
  // A successful Form rewrite supersedes the earlier top-level fallback. Only
  // clear it after saving, and keep it if any corresponding local unit fell back.
  for (const [unit, failure] of formFailures) {
    const index = workerData.units.indexOf(unit)
    if (!failure) retainedUnits.delete(index)
    else if (retainedUnits.has(index)) Object.assign(retainedUnits.get(index), failure)
  }
  parentPort.postMessage(
    { data, layoutFailures: [...retainedUnits.values()], diagnostics: diagnostics() },
    [data.buffer]
  )
} catch (error) {
  parentPort.postMessage({
    failure: error.failure ?? { code: 'worker-failed' },
    diagnostics: diagnostics()
  })
}
