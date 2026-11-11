import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { findNativeCenteredVectorCaptionTail } from './literature-pdf-native-centered-vector-caption-tail.mjs'
import { nativePrintedTableBodyReference } from './literature-pdf-native-printed-table-reference.mjs'
import { nativeRuledScriptCaptionIdentity } from './literature-pdf-native-ruled-script-caption-identity.mjs'
import {
  retainNativeRecoveryInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'
import {
  nativeCaptionRaisedIndexLines,
  nativeCaptionLiteralFragments,
  nativeCaptionProvenControlFragments,
  nativeCaptionOwnedInlineFragments
} from './literature-pdf-native-caption-script-order.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Offline geometry heuristic; a caption candidate is not a semantic classification.
import assert from 'node:assert/strict'
import { recoverNativeRaisedCaptionFragments } from './literature-pdf-native-caption-raised-glyphs.mjs'
import {
  rememberNativeGroupedCaptionRuns,
  nativePageTextPacketInventory,
  nativePageTextPacketInventoryWithLigatureCertificate,
  nativeTypedPlotPacketInventory,
  createNativeFigurePaintCertificate,
  nativeFigurePaintCertificateData
} from './literature-pdf-figure-native-plot-labels.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeWholeSourceGlyphObservations } from './literature-pdf-symbol-text.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeConditionalFigureReference } from './literature-pdf-native-conditional-figure-reference.mjs'
import { nativePrintedCaptionBodyReference } from './literature-pdf-native-printed-caption-reference.mjs'

// A PDF stream may paint a small script after the rest of its physical line.
// Move it only when exactly one earlier token adjoins it and all intervening
// text lies beyond its right edge on the anchor baseline. Preserve all glyphs.
function orderDelayedInlineScripts(items) {
  const ordered = [...items]
  for (const item of items) {
    if (!/^[a-zA-Z0-9]{1,2}$/.test(item.str) || item.height <= 0) continue
    const index = ordered.indexOf(item)
    if (index < 2) continue
    const anchors = ordered.slice(0, index - 1).filter((anchor, n) => {
      if (
        !anchor.str.trim() ||
        item.height >= anchor.height * 0.7 ||
        [anchor, item].some((part) => part.transform[0] <= 0 || part.transform[1] !== 0)
      )
        return false
      const gap = item.transform[4] - anchor.transform[4] - anchor.width
      const offset = Math.abs(item.transform[5] - anchor.transform[5])
      const middle = ordered.slice(n + 1, index).filter((part) => part.str.trim())
      return (
        gap >= -anchor.height * 0.1 &&
        gap <= anchor.height * 0.35 &&
        offset > anchor.height * 0.08 &&
        offset <= anchor.height * 0.5 &&
        middle.length > 0 &&
        middle.every(
          (part) =>
            part.transform[1] === 0 &&
            part.transform[0] > 0 &&
            Math.abs(part.transform[5] - anchor.transform[5]) <= anchor.height * 0.1 &&
            part.transform[4] >= item.transform[4] + item.width
        )
      )
    })
    if (anchors.length !== 1) continue
    ordered.splice(index, 1)
    ordered.splice(ordered.indexOf(anchors[0]) + 1, 0, item)
  }
  return ordered
}

// PDF.js can insert a zero-height space when small caps change font size even
// though the next glyph starts at the previous glyph's advance. Join only that
// typographic pattern; ordinary word spaces and raised/lowered text stay intact.
export function joinPdfSmallCapsLine(items) {
  items = orderDelayedInlineScripts(items)
  return items
    .map((item, index) => {
      const before = items[index - 1],
        after = items[index + 1]
      if (
        item.str === ' ' &&
        item.height === 0 &&
        item.width <= 0.02 &&
        before &&
        after &&
        ((/(?:^|[\s-])[A-Z]$|^-$/.test(before.str) &&
          /^[A-Z]+$/.test(after.str) &&
          after.height >= before.height * 0.65 &&
          after.height <= before.height * 0.85) ||
          (/^[A-Z]+$/.test(before.str) &&
            /^[-.,*]+(?:\s?[A-Z])?$/.test(after.str) &&
            before.height >= after.height * 0.65 &&
            before.height <= after.height * 0.85)) &&
        before.fontName === after.fontName &&
        before.transform[1] === 0 &&
        before.transform[2] === 0 &&
        after.transform[1] === 0 &&
        after.transform[2] === 0 &&
        before.transform[0] > 0 &&
        after.transform[0] > 0 &&
        Math.abs(before.transform[5] - after.transform[5]) <= 0.01 &&
        Math.abs(after.transform[4] - before.transform[4] - before.width) <=
          Math.max(before.height, after.height) * 0.025
      )
        return ''
      return item.str
    })
    .join('')
    .trim()
}

// Manuscript line numbers are separate native runs. Require an aligned,
// consecutive margin sequence and matching body baselines before excluding it.
// Isolated numbers, chart ticks and numbered list content remain untouched.
export function excludePdfLineNumbers(content, viewport, nativeTableProof = {}) {
  const candidates = content.items.filter((item) => {
    if (!/^\d{1,4}$/.test(item.str?.trim() ?? '') || item.height <= 0) return false
    const [x] = viewport.convertToViewportPoint(...item.transform.slice(4))
    return x < viewport.width * 0.1 || x > viewport.width * 0.9
  })
  const excluded = new Set()
  for (const anchor of candidates) {
    if (excluded.has(anchor)) continue
    const column = candidates
      .filter(
        (item) =>
          Math.abs(item.transform[4] - anchor.transform[4]) < 2 &&
          Math.abs(item.height - anchor.height) < 0.5
      )
      .sort((a, b) => b.transform[5] - a.transform[5])
    if (
      column.length < 8 ||
      column.some(
        (item, i) =>
          i &&
          (Number(item.str) !== Number(column[i - 1].str) + 1 ||
            column[i - 1].transform[5] - item.transform[5] < item.height)
      )
    )
      continue
    const paired = column.filter((item) =>
      content.items.some(
        (body) =>
          body.str?.length > 20 &&
          Math.abs(body.transform[5] - item.transform[5]) < 1 &&
          (body.transform[4] > item.transform[4] + item.width + item.height ||
            body.transform[4] + body.width < item.transform[4] - item.height)
      )
    )
    if (paired.length < 6) continue
    if (hasNativeIndexedTableFrame(column, content.items, viewport, nativeTableProof)) continue
    for (const item of column) excluded.add(item)
  }
  return { ...content, items: content.items.filter((item) => !excluded.has(item)) }
}

// The default margin filter remains unchanged. Exempt an indexed table only
// when its detector boundary, unique descriptive caption and both native
// horizontal borders independently enclose every number and paired label.
function hasNativeIndexedTableFrame(
  column,
  items,
  viewport,
  { tableRects = [], captions = [], rules = [] }
) {
  const height = Math.max(...column.map((i) => i.height))
  const ink = (i) => {
    const [x, baseline] = viewport.convertToViewportPoint(...i.transform.slice(4))
    return [x, baseline - i.height, x + i.width, baseline]
  }
  const inside = (r, i) => {
    const box = ink(i)
    return (
      box[0] >= r[0] - height * 0.01 &&
      box[2] <= r[2] + height * 0.01 &&
      box[1] >= r[1] &&
      box[3] <= r[3]
    )
  }
  const matching = tableRects.filter((r) => column.every((i) => inside(r, i)))
  if (matching.length !== 1) return false
  const rect = matching[0]
  const borders = rules.filter(
    (r) =>
      r[1] === r[3] &&
      Math.abs(r[0] - rect[0]) < height * 1.5 &&
      Math.abs(r[2] - rect[2]) < height * 1.5
  )
  const top = borders.filter(
    (r) =>
      Math.abs(r[1] - rect[1]) < height * 1.5 && r[1] < Math.min(...column.map((i) => ink(i)[1]))
  )
  const bottom = borders.filter(
    (r) =>
      Math.abs(r[1] - rect[3]) < height * 1.5 && r[1] > Math.max(...column.map((i) => ink(i)[3]))
  )
  if (
    top.length !== 1 ||
    bottom.length !== 1 ||
    Math.abs(top[0][0] - bottom[0][0]) > 0.1 ||
    Math.abs(top[0][2] - bottom[0][2]) > 0.1
  )
    return false
  const frame = [top[0][0], top[0][1], top[0][2], bottom[0][1]]
  const owned = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      /\p{L}/u.test(c.lines.slice(1).join(' ')) &&
      c.rect[3] <= frame[1] &&
      frame[1] - c.rect[3] < height * 3 &&
      // Caption paragraph advance boxes can slightly overhang an otherwise
      // complete ruled table. Keep this font-sized allowance local to the
      // unique caption proof; all numbered records and paired labels still
      // have to lie inside both native borders.
      c.rect[0] >= frame[0] - height * 1.5 &&
      c.rect[2] <= frame[2] + height * 1.5
  )
  if (owned.length !== 1 || !column.every((i) => inside(frame, i))) return false
  return column.every((number) => {
    const labels = items.filter(
      (i) =>
        i.str?.trim() &&
        i.transform[4] > number.transform[4] + number.width + number.height &&
        i.transform[4] < frame[2] &&
        Math.abs(i.transform[5] - number.transform[5]) < 1
    )
    return (
      labels.length > 0 &&
      labels.every(
        (i) =>
          i.transform[0] > 0 && i.transform[1] === 0 && i.transform[2] === 0 && inside(frame, i)
      )
    )
  })
}

// PDF streams can interleave columns at almost the same baseline without EOL.
// Split at a physical gutter or a backward column jump before concatenating text.
export function startsDetachedTextColumn(pending, item) {
  const before = pending.findLast((part) => part.str.trim() && part.height > 0)
  if (!before || !item.str.trim() || item.height <= 0) return false
  if (
    [before, item].some(
      (part) => part.transform[0] <= 0 || part.transform[1] !== 0 || part.transform[2] !== 0
    )
  )
    return false
  // Limit this repair to different text sizes, such as a small caption beside
  // body prose. Equal-size columns keep their established stream grouping.
  if (Math.min(before.height, item.height) > Math.max(before.height, item.height) * 0.85)
    return false
  const tolerance = Math.max(before.height, item.height) * 2
  return (
    item.transform[4] - before.transform[4] - before.width > tolerance ||
    before.transform[4] - item.transform[4] - item.width > tolerance
  )
}

// Descriptive parenthetical qualifiers do not turn a coordinated finite
// Figure subject into a caption. Parse each reference once; punctuation after
// an ordinal or after the list still belongs to a genuine caption title.
function isCoordinatedFigureSubject(text) {
  let tail = text,
    count = 0
  for (;;) {
    const label = /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\b/iu.exec(tail)
    if (!label) return false
    tail = tail.slice(label[0].length)
    const qualifier = /^\s*\(([\p{L}\p{N}\s-]+)\)/u.exec(tail)
    if (qualifier) tail = tail.slice(qualifier[0].length)
    count++
    const separator = /^\s*(?:,\s*(?:(?:and|&)\s+)?|(?:and|&)\s+)/iu.exec(tail)
    if (!separator) break
    tail = tail.slice(separator[0].length)
  }
  return (
    count >= 2 &&
    /^\s+(?:(?:also|further)\s+)?(?:show(?:s)?|compare(?:s)?|illustrate(?:s)?|depict(?:s)?|present(?:s)?|describe(?:s)?|demonstrate(?:s)?)\b/iu.test(
      tail
    )
  )
}

export function captionKind(text) {
  // Normalize every compact reference before applying the coordinated-subject
  // guards, including the second reference in a running sentence.
  text = (text ?? '').replace(/\bFig\.(?=\d)/gi, 'Fig. ')
  // A punctuation-delimited alphabetic ordinal uses the same caption grammar
  // as a numbered title. This local alias never changes displayed source text.
  text = text.replace(/^((?:Fig\.?|Figure)\s+)[A-Z](?=[.:]\s+\p{L})/u, '$11')
  if (isCoordinatedFigureSubject(text ?? '')) return undefined
  if (
    /^(?:Figure|Fig\.)\s+[A-Z]?\d+\s+\((?:Appendix|Supplement(?:ary)?(?: material)?)\)\s+(?:shows?|illustrates?|depicts?|presents?|describes?)\b/iu.test(
      text
    )
  )
    return undefined
  // A printed supplementary ordinal may use several letters. Classify only
  // its punctuation-delimited title through the existing single-letter
  // grammar; the source label and all prose-reference guards remain intact.
  text = (text ?? '').replace(
    /^((?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure)\s+)[A-Z]{2,3}(\d+(?:\.\d+)*)(?=[.:]\s+\p{L})/iu,
    '$1S$2'
  )
  // A same-page continued block can carry only its ordinal and source row
  // range. Require the entire label so narrative uses of "continued" stay prose.
  if (
    /^(?:Table|Tab\.?)\s+(?:[A-Z]?\d+(?:\.\d+)*|[A-Z]\.\d+|[IVXLCDM]+)\s*,\s*(?:continued|contd\.?)(?:\s+\((?:items|rows)\s+\d+\s*[-–]\s*\d+\))?\.?$/i.test(
      text?.trim() ?? ''
    )
  )
    return 'table'
  // Preserve the printed label; these substitutions are only classification
  // aliases. Finite-verb references remain prose in each supported language.
  if (
    /^(?:Figura|Tabla|▶?\s*(?:Abb\.|Tab\.))\s*[A-Z]?\d+\.?\s+(?:muestra|muestran|presenta|presentan|ilustra|ilustran|se\s+(?:muestra|presenta)|zeigt|zeigen|enthält|enthalten|stellt|stellen)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  // These numbered references are paragraph prose rather than captions. The
  // citation form is especially distinctive. Panel references with a sentence
  // opener and unpunctuated quantifier references are likewise paragraph prose.
  if (
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+of\s+[\p{L}][\p{L}-]*(?:\s+et\s+al\.)?\s*\(\d{4}[a-z]?\)/iu.test(
      text ?? ''
    )
  )
    return undefined
  if (
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+\((?:left|right|top|bottom|middle|center|centre|[A-Za-z])\)\.\s+(?:The|This|These|Those|Our|Their|It|They)\b/i.test(
      text ?? ''
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+\(Section\s+[^)]+\)\.\s+(?:The|This|These|Those|Our|Their|It|They)\b/i.test(
      text ?? ''
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*[.:]\s+(?:The|This|These|Those|Our|Their|It|They)\b[^.!?]{0,180}\b(?:in|from|of|after)\s+\[\d+\]\s+(?:is|are|was|were)\s+to\b/i.test(
      text ?? ''
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+(?:all|both|each)\b/i.test(text ?? '')
  )
    return undefined
  // A numbered figure reference can be split at the start of a paragraph
  // before a short sentence opener. Keep these narrow prose shapes out of
  // caption ownership while preserving ordinary noun titles.
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*[,:]\s+(?:we|our)\s+(?:show|present|compare|evaluate|report|describe|visuali[sz]e|plot)\b/i.test(
      text ?? ''
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*[.:]\s+(?:Therefore|Thus),?\b/i.test(text ?? '') ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+and\s+Appendix\s+Tab\.?\s+[A-Z]?\d+\s+(?:we|our)\b/i.test(
      text ?? ''
    ) ||
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*(?:\s+and\s+(?:(?:Fig\.?|Figure)\s+)?[A-Z]?\d+|\s+and\s+Appendix\s+Tab\.?\s+[A-Z]?\d+)?\s+(?:we|our)\s+(?:show|present|compare|evaluate|report|describe|visuali[sz]e|plot)\b/i.test(
      text ?? ''
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+(?:top|bottom|left|right|middle)\s+row\.\s+Note\b/i.test(
      text ?? ''
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+and\s+[A-Z]?\d+[.:]\s+(?:To|For|As|In|When|Where|Since|Because)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  text = (text ?? '')
    // Some publishers punctuate the full keyword before its printed ordinal.
    // This is a classification alias only; preserve every source caption glyph.
    .replace(/^Figure\.(?=\s+[A-Z]?\d)/i, 'Figure')
    .replace(/^Figura(?=\s+[A-Z]?\d)/i, 'Figure')
    .replace(/^Tabla(?=\s+[A-Z]?\d)/i, 'Table')
    .replace(/^▶?\s*Abb\.(?=\s*[A-Z]?\d)/i, 'Fig.')
    .replace(/^▶\s*Tab\.(?=\s*[A-Z]?\d)/i, 'Table')
  // Panel-qualified figure references at the start of a paragraph are not
  // captions when the next sentence reads as ordinary prose.
  if (
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s*[A-Za-z]\.[\s]+(?:The|This|These|Those|Our|Their|It|They|Results?)\b[^.!?]{0,90}\b(?:is|are|was|were|has|have|had|does|do|did|shows?|demonstrates?|indicates?|describes?|reveals?|suggests?|compares?|contains?|includes?|uses?|achieves?|improves?|changes?|remains?|represents?|provides?|illustrates?)\b/i.test(
      text
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+and\s+(?:Fig\.?|Figure)\s+[A-Z]?\d+\.[\s]+(?:As|For|In|When|Where|Since|Because|The|This|These|Those)\b/i.test(
      text
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+[A-Za-z]?\s+and\s+(?:is|are|was|were|suggests?|shows?|indicates?|demonstrates?|describes?|reveals?)\b/i.test(
      text
    )
  )
    return undefined
  if (/^\(Table\s+[A-Z]?\d+\)\s+(?:Contd|Continued)[.．…]*$/i.test(text?.trim() ?? ''))
    return 'table'
  if (/^\((?:Fig\.?|Figure)\s+\d+\s+continues on (?:the )?next page\)$/i.test(text?.trim() ?? ''))
    return 'figure'
  // Publisher/appendix prefixes belong to the displayed label. Normalize only
  // for classification; keep the original caption text and source rectangle.
  text = (text ?? '')
    .replace(/^TaggedEnd(?=Table\s+\d)/, '')
    .replace(/^Appendix\s+(?=(?:Figure|Fig\.|Table)\b)/i, '')
    .replace(/^Legend to\s+(?=(?:Figure|Fig\.?)\s+[A-Z]?\d+[.:])/i, '')
    .replace(/^Tableau(?=\s+[A-Z]?\d+(?:[.:\s]|$))/i, 'Table')
    .replace(/^Fig\.(?=\d)/i, 'Fig. ')
  // Apply the shared prose guards before the appendix branch can return.
  // Panel markers and hyphenated labels cannot hide a finite narrative verb;
  // punctuation-delimited noun titles keep their ordinary caption ownership.
  const narrativeReferenceLabel =
    '(?:(?:Supplementary|Supplemental)\\s+)?(?:Table|Tab\\.?|Chart|Fig\\.?|Figure)\\s+(?:[A-Z]?\\d+(?:\\.\\d+)?|[A-Z][.-]\\d+(?:\\.\\d+)*|[IVXLCDM]+)'
  // An article-led noun title ("A review of ...") is not panel A plus a verb.
  const narrativeReferencePanel =
    '(?:\\s+(?!a\\s+(?:review|display|measure|list|report|contrast|complement|plot|split|break|set|use|show|exhibit)\\b)[A-Za-z](?=\\s)|\\s*\\((?:[A-Za-z]|left|right|top|bottom|middle|center|centre)\\)(?:\\s*(?:,|and|&)\\s*\\((?:[A-Za-z]|left|right|top|bottom|middle|center|centre)\\))*)?'
  const narrativeReferenceVerb =
    '(?:is|are|was|were|has|have|had|shows?|shown|presents?|presented|compares?|compared(?=\\s+(?:the|these|those|this|that|our)\\b)|contrasts?|measures?|reports?|reported|confirms?|reveals?|illustrat(?:es?|ed)|visuali[sz](?:es?|ed)|analy[sz](?:es?|ed)|provides?|plots|flips|clarifies|assesses|gives?|follows?|splits?|separates?|breaks?|lists?|decomposes?|contains?|depict(?:s|ed)?|represents?|reiterates?|reviews|summari[sz](?:e(?:s|d)?|ing)|indicates?|suggests?|describes?|demonstrates?|displays?|exhibits?|highlights?|details?|achieves?|carr(?:y|ies|ied)|extends?|preserves?|retains?|grounds?|defines?|makes?|sets?|adds?|complements?|uses?(?=\\s+(?:one|a|an|the|our|this|these|those|its|their|\\d+)\\b)|examines?|var(?:y|ies|ied)|evaluates?|isolates?|paves?|introduces?)'
  // A singular numbered subject takes "reviews" as its finite verb. Bare
  // "review" can head a noun title; coordinated subjects still take "review".
  const coordinatedPanel =
    '(?:\\((?:[A-Za-z]|left|right|top|bottom|middle|center|centre)\\)|[A-Za-z])'
  if (
    new RegExp(
      `^${narrativeReferenceLabel}${narrativeReferencePanel}(?:\\s*(?:,|and|&)\\s*(?:${narrativeReferenceLabel}|[A-Z]?\\d+(?:\\.\\d+)?)${narrativeReferencePanel})+\\s+(?:(?:also|further|first)\\s+)?review\\b`,
      'iu'
    ).test(text) ||
    new RegExp(
      `^${narrativeReferenceLabel}\\s*${coordinatedPanel}(?:\\s*(?:,\\s*(?:and\\s+)?|and\\s+|&\\s*)${coordinatedPanel})+\\s+(?:(?:also|further|first)\\s+)?review\\b`,
      'iu'
    ).test(text)
  )
    return undefined
  const narrativeReference = new RegExp(
    `^${narrativeReferenceLabel}${narrativeReferencePanel}(?:\\s*(?:,|and|&)\\s*(?:${narrativeReferenceLabel}|[A-Z]?\\d+(?:\\.\\d+)?)${narrativeReferencePanel})*\\s+(?:(?:also|further|first)\\s+)?${narrativeReferenceVerb}\\b`,
    'i'
  )
  // Keep "score" as a noun in titles such as "Figure 2 score distributions";
  // reject only the finite-verb form when a following object establishes prose.
  const scoredReference = new RegExp(
    `^${narrativeReferenceLabel}${narrativeReferencePanel}\\s+scores\\b(?!\\s+for\\b)\\s+\\p{L}{2,}(?:\\s+(?:by|on|across|over|for|using|with|from)\\b|\\s+\\p{L}{2,}\\b)`,
    'iu'
  )
  if (scoredReference.test(text)) return undefined
  // An unpunctuated figure subject followed by an inflected transitive verb
  // and a determiner-led object is running prose. Require the complete local
  // grammar: noun titles and punctuation-delimited captions retain ownership.
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Figure|Fig\.?)\s+/i.test(text) &&
    new RegExp(
      `^${narrativeReferenceLabel}${narrativeReferencePanel}\\s+(?:(?:also|further|directly)\\s+)?[a-z]+(?:ifies|izes|ises|ates)\\s+(?:the|this|that|these|those|our|their|its|a|an)\\s+\\p{L}`,
      'iu'
    ).test(text)
  )
    return undefined
  // A complete panel range followed by show/shows is a running Figure subject.
  // Keep punctuation-delimited and noun titles outside this narrow grammar.
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Figure|Fig\.?)\s+/i.test(text) &&
    new RegExp(
      `^${narrativeReferenceLabel}(?:\\s*\\([A-Za-z]\\)\\s*-\\s*\\([A-Za-z]\\)|\\s*[A-Za-z]\\s*[-–]\\s*[A-Za-z])\\s+(?:(?:also|further)\\s+)?shows?\\b`,
      'i'
    ).test(text)
  )
    return undefined
  // These finite figure subjects introduce prose, while a punctuation-delimited
  // title can still describe a translation or verification. Keep the added
  // verbs out of the broader punctuated-subject and title guards below.
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Figure|Fig\.?)\s+/i.test(text) &&
    new RegExp(
      `^${narrativeReferenceLabel}${narrativeReferencePanel}\\s+(?:(?:also|further|directly)\\s+)?(?:translates?|verif(?:y|ies)|reflects?|integrates|turns(?=\\s+(?:this|that|these|those)\\b)|overlays(?=\\s+(?:the|these|those|this|that|our|their|its|a|an)\\b))\\b`,
      'i'
    ).test(text)
  )
    return undefined
  // These finite subjects require an explicit object determiner. Noun titles
  // such as "Records of ..." and punctuation-delimited captions remain titles.
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Figure|Fig\.?)\s+/i.test(text) &&
    new RegExp(
      `^${narrativeReferenceLabel}${narrativeReferencePanel}\\s+(?:records|pairs|renders|tests|showcases|takes|supplements|encodes)\\s+(?:the|this|that|these|those|a|an|our|their|its|both|each|some|several|multiple|one|two|\\d+)\\s+\\p{L}`,
      'iu'
    ).test(text)
  )
    return undefined
  // A local side qualifier does not change a finite Figure subject into a title.
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Figure|Fig\.?)\s+/i.test(text) &&
    new RegExp(
      `^${narrativeReferenceLabel}${narrativeReferencePanel}\\s+on\\s+the\\s+(?:(?:upper|lower)\\s+)?(?:left|right)\\s+(?:(?:also|further)\\s+)?${narrativeReferenceVerb}\\b`,
      'i'
    ).test(text)
  )
    return undefined
  // A local document qualifier can separate a Figure subject from its verb.
  // Require an unpunctuated label and the existing finite-verb grammar; a
  // noun title or a colon before its description keeps caption ownership.
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Figure|Fig\.?)\s+/i.test(text) &&
    new RegExp(
      `^${narrativeReferenceLabel}${narrativeReferencePanel}\\s+of\\s+the\\s+(?:main\\s+)?(?:paper|article)\\s+(?:(?:also|further)\\s+)?${narrativeReferenceVerb}\\b`,
      'i'
    ).test(text)
  )
    return undefined
  const unpunctuatedFigureReference =
    /^(?:fig\.?|figure)\s+(?:[A-Z]?\d+|[A-Z][.-]\d+(?:\.\d+)*)\s+(?:for|in|as|when|where|since|because|to|the|this|these|those|however|therefore|thus)\b/i.test(
      text ?? ''
    )
  // Appendix ordinals have a letter followed by a decimal or hyphenated number. Classify
  // the whole printed ordinal before the Roman-label path can mistake C.1
  // for table C. The source text is never rewritten.
  const appendix =
    /^(Table|Tab\.?|Fig\.?|Figure|Chart)\s+[A-Z][.-]\d+(?:\.\d+)*(?=[\s.:)]|$)(.*)$/i.exec(text)
  if (appendix) {
    if (narrativeReference.test(text) || unpunctuatedFigureReference) return undefined
    const tail = appendix[2]
    if (
      /^\)/.test(tail) ||
      /^[,:]\s+(?:we|our)\s+(?:show|present|compare|evaluate|report|describe|visuali[sz]e|plot)\b/i.test(
        tail
      ) ||
      /^[.:]\s+(?:Therefore|Thus),?\b/i.test(tail) ||
      /^\s+(?:and\s+(?:Table|Tab\.?|Fig\.?|Figure|Chart)\s+[A-Z][.-]\d+(?:\.\d+)*\s+)?(?:(?:also|further)\s+)?(?:is|are|was|were|has|have|had|reports?|reported|shows?|shown|presents?|presented|illustrat(?:es?|ed)|visuali[sz](?:es?|ed)|plots?|gives?|follows?|ablates?|sweeps?|tests?|evaluates?|compares?|measures?|depict(?:s|ed)?|represents?|contains?|lists?|summari[sz](?:e(?:s|d)?|ing)|indicates?|suggests?|describes?|demonstrates?|preserves?|retains?|grounds?|defines?|makes?|sets?|adds?|complements?|uses?(?=\s+(?:one|a|an|the|our|this|these|those|its|their|\d+)\b)|in\s+(?:the\s+)?(?:Appendix|Supplement(?:ary)?|Section|ESM))\b/i.test(
        tail
      ) ||
      /^[.:]\s+(?:It|This|These|Those)\s+(?:should|is|are|was|were|has|have|had|contains?|includes?)\b/i.test(
        tail
      )
    )
      return undefined
    return /^(?:Table|Tab\.?)$/i.test(appendix[1]) ? 'table' : 'figure'
  }
  // Some appendices omit the separator in labels such as "Table D4.". Keep
  // this compact form narrow: a punctuation-delimited title is required so
  // running references such as "Table S6 generalizes ..." still reach the
  // existing prose guards below.
  const compactTableAppendix = /^(Table|Tab\.?)\s+[A-Z]\d+(?:\.\d+)*(?=[\s.:)]|$)(.*)$/i.exec(text)
  const romanTableTail = /^(?:Table|Tab\.?)\s+[IVXLCDM]+\s*([.:]\s+.*)$/i.exec(text)?.[1]
  const punctuatedTableTail = compactTableAppendix?.[2] ?? romanTableTail
  if (
    punctuatedTableTail &&
    (/^[.:]\s+(?:Therefore|Thus|However|Meanwhile|Additionally|Moreover),?\s+(?:reports?|shows?|presents?|describes?|indicates?|demonstrates?)\b/i.test(
      punctuatedTableTail
    ) ||
      /^[.:]\s+(?:Among|Below|In each|For instance|Unlike)\b(?=[\s\S]*\b(?:is|are|differ|differs|report|reports|increase|increases|improve|improves|achieves?|shows?)\b)/i.test(
        punctuatedTableTail
      ) ||
      /^[.:]\s+To\s+(?:compare|check|verify)\b[\s\S]*\bwe\s+(?:repeat|compare|report|find|show|use|measure)\b/i.test(
        punctuatedTableTail
      ))
  )
    return undefined
  // The final numbered-label matcher already accepts compact appendix
  // ordinals. Let them pass through the same remaining prose guards as
  // ordinary numbered captions before assigning ownership.
  // A closing parenthesis ends an inline cross-reference, not a caption.
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure|Table)\s+[A-Z]?\d+(?:\s+[A-Z](?:\s*(?:[+,&/–-]|and)\s*[A-Z])*)?(?:\s+and\s+(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure|Table)\s+[A-Z]?\d+)?\)[.,]/i.test(
      text
    )
  )
    return undefined
  // Hungarian captions place the ordinal before the figure/table noun.
  // Require the complete noun, retaining inflected in-text references as prose.
  const ordinalLabel = /^\d+\.\s+(ábra|táblázat)(?=\s|$)/i.exec(text)
  if (ordinalLabel) return ordinalLabel[1].toLowerCase() === 'ábra' ? 'figure' : 'table'
  if (/^(?:Figure|Fig\.?)\s+\d+\s+(?:but\b|\(available\b)/i.test(text)) return undefined
  // Retain the publisher's standalone full-keyword label with spaced punctuation.
  // A tight label-only prefix needs a descriptive title before claiming a region.
  if (/^Figure\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+)\s+[.:]\s*$/i.test(text.trim())) return 'figure'
  if (/^(?:Fig\.?|Figure)\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+)[.:]\s*$/i.test(text.trim()))
    return undefined
  // Small-caps manuscript labels use an all-caps TABLE prefix. Keep that
  // source form eligible so the ruled-title continuation pass can attach its
  // centered number to the descriptive title below.
  if (/^TABLE\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+)\.\s*$/u.test(text.trim())) return 'table'
  if (/^(?:Table|Tab\.?)\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+)\.\s*$/i.test(text.trim()))
    return undefined
  // "List of ..." is a noun title; "lists ..." remains a finite-verb reference.
  if (/^Table\s+[A-Z]?\d+\s+List of\s+\p{L}/u.test(text)) return 'table'
  // A numbered table reference can look like a caption when a PDF stream
  // starts a new line at the reference. These finite-verb forms introduce
  // surrounding prose, not a table title; keep them out of ownership and
  // crop matching. Descriptive titles remain eligible after the label.
  if (
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+\s+(?:reports?|reported|shows?|shown|presents?|presented|describes?|contains?|lists?|summari[sz](?:es|ed|ing)?|indicates?|demonstrates?|highlights?|consolidates?|places?|outlines?|changes?|records?|generalizes?|measures?|reveals?|reads?|sweeps?|groups?|excludes?|distinguishes?|denotes?|details?|removes?|expresses?|separates?|explains?|tracks?|trains?|evaluates?|ablates?|moves?|scores?|repeats?|reproduc(?:es?|ed)|isolates?|expands?|covers?|buckets?|combines?)\b/i.test(
      text
    ) ||
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+[.:]\s+(?:It|This|These|Those)\s+(?:should|is|are|was|were|has|have|had|contains?|includes?)\b/i.test(
      text
    )
  )
    return undefined
  // A reference followed by a discourse connector and a finite verb is a
  // sentence lead, not a caption title. Keep the connector set narrow so
  // ordinary noun captions such as `Table S4: Retrieval results` remain
  // eligible while prose like `Table S4 therefore reports ...` cannot claim
  // the neighboring table region.
  if (
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+(?:\.\d+)*\s+(?:therefore|thus|however|meanwhile|additionally|moreover),?\s+(?:reports?|shows?|presents?|describes?|indicates?|demonstrates?|summari[sz](?:es|ed|ing)?|lists?|contains?|reveals?|records?)\b/i.test(
      text
    )
  )
    return undefined
  if (/^table\.\s+First,/i.test(text)) return undefined
  if (/^(?:Table|Tab\.?)\s+[A-Z]?\d+[.:]\s+Spearman\s+ρ\s*=/iu.test(text)) return undefined
  if (/^(?:Table|Tab\.?)\s+[A-Z]?\d+[.:]\s+(?:Among|Below)\b/i.test(text)) return undefined
  if (/^Table\s+[A-Z]\s*=\s*\(/.test(text)) return undefined
  if (/^Table\s+[A-Z]?\d+\s+use\s+predicted\b/i.test(text)) return undefined
  // A few next-batch references keep the same sentence shape but use a
  // parenthetical appendix marker, a Roman ordinal, an omitted repeated
  // label, or an infinitive continuation. These are paragraph prose rather
  // than captions; keep the guards narrow so noun titles remain eligible.
  if (
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+\s+\([^)]*\)\s+(?:changes?|enumerates?|repeats?|quantifies?|summari[sz](?:es|ed|ing)?|gives?|provides?)\b/i.test(
      text
    ) ||
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+\s+(?:enumerates?)\b/i.test(text) ||
    /^(?:Table|Tab\.?)\s+[IVXLCDM]+\s+(?:repeats?|quantifies?|enumerates?|collects?|records?|gives?|provides?)\b/i.test(
      text
    ) ||
    /^(?:Table|Tab\.?)\s+[IVXLCDM]+\s+\([^)]*%[^)]*\)\.\s+D(?:[_a-z]*,\s*j)\b/i.test(text) ||
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+\s+to\s+the\s+full\b/i.test(text) ||
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+\s+and\s+[A-Z]?\d+\s+(?:gives?|provide|provides?|repeats?|quantifies?)\b/i.test(
      text
    )
  )
    return undefined
  if (
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+[.:]\s+Equation\s+\(\d+\)\s+agrees?\b/i.test(text) ||
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+[.:]\s+Unlike\s+the\b/i.test(text)
  )
    return undefined
  // Roman-numbered references and sentence-opening continuations use the
  // same label shape but are still running prose (for example, "Table IV
  // details ..." or "Table 1. For instance, ..."). Keep these narrow forms
  // out of caption ownership while leaving descriptive noun titles eligible.
  if (
    /^(?:Table|Tab\.?)\s+[IVXLCDM]+\s+details?\b/i.test(text) ||
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+(?:[.:])\s+(?:In each|For instance)\b/i.test(text)
  )
    return undefined
  if (/^(?:Table|Tab\.?)\s+[A-Z]?\d+\s+(?:contrasts?|collects?)\b/i.test(text)) return undefined
  // A page-direction phrase makes a numbered table label an in-text pointer,
  // even when the following verb is split onto the same extracted line. Such
  // references commonly introduce tables on the next page and must not own a
  // table or absorb the surrounding paragraph as a caption.
  if (
    /^(?:Table|Tab\.?)\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+)\s+(?:on|in|from)\s+(?:the\s+)?(?:next|following|previous)\s+page\b/i.test(
      text
    )
  )
    return undefined
  // A table label can begin a sentence that explains how a comparison was
  // performed, rather than naming the table itself.  Keep this guard narrow:
  // require the observed infinitive/propositional openings and a later
  // sentence-level continuation, while leaving noun titles such as
  // "Table 5. To-scale measurements" eligible.
  if (
    /^(?:Table|Tab\.?)\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+)\s*[.:]\s+To\s+(?:check|verify|confirm|ensure|compare|assess|test)\b[\s\S]*(?:,\s+(?:we|our|the|they|this|these)\b|\b(?:we|our|they)\s+(?:repeat|compare|report|find|show|use|measure))\b/i.test(
      text
    ) ||
    /^(?:Table|Tab\.?)\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+)\s+to\s+(?:our|the)\s+sign\s+convention\b/i.test(
      text
    )
  )
    return undefined
  // Reproduction maps often begin rows with a figure label and a section
  // reference (for example, "Figure 1 (§4.7) figures/..."). These are table
  // cells, not figure captions; the bare section form can be emitted as a
  // separate line by the PDF text stream.
  if (/^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+\(§?\s*\d+(?:\.\d+)*\)(?:\s|$)/i.test(text))
    return undefined
  if (/^Table\s+[A-Z]?\d+\s+maps\s+each\s+figure\s+and\s+data\s+table\b/i.test(text))
    return undefined
  if (
    /^(?:Table|Fig\.?|Figure)\s+(?:[A-Z]?\d+|[IVXLCDM]+)\s+in\s+(?:the\s+)?(?:Appendix|Supplement(?:ary)?|Section|ESM)\b/i.test(
      text
    )
  )
    return undefined
  if (narrativeReference.test(text ?? '')) return undefined
  if (
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+(?:solidifies|connects|serves\s+(?:two|three|several)\s+purposes)\b/i.test(
      text
    )
  )
    return undefined
  // A plain numbered label followed by a sentence opener is body prose even
  // when the opener is capitalized after a period. The panel-specific guard
  // below intentionally handles letter-suffixed labels; keep this companion
  // rule broad enough for ordinary `Fig./Figure N. As|For|In ...` references
  // while requiring a later finite verb so noun titles such as
  // `Figure 3. Inference results` remain valid captions.
  // A complete parenthetical qualifier before that sentence-ending period
  // still belongs to the reference; a caption colon before it remains distinct.
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*(?:\s+\([^()\r\n]+\))?[.:]\s+(?:As|For|In|When|Where|Since|Because|Like|Unlike)\b(?=[\s\S]*\b(?:is|are|was|were|has|have|had|does|do|did|shows?|presents?|contains?|includes?|uses?|provides?|reports?|describes?|demonstrates?|indicates?|suggests?|reveals?|means?)\b)/i.test(
      text ?? ''
    )
  )
    return undefined
  if (/^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+we\s+plot\b/i.test(text ?? '')) return undefined
  if (/^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+asks?\s+whether\b/i.test(text ?? '')) return undefined
  // A lower-case `fig.` at the start of a paragraph can be an inline
  // reference whose sentence subject is carried directly after the label.
  // Keep noun-style titles eligible, but reject the finite-sentence forms
  // that otherwise claim the preceding figure's graphics as a second crop.
  if (
    /^fig\.\s+[A-Z]?\d+(?:\.\d+)*[.:]\s+(?:Our|This|These|Their)\b(?=[\s\S]*\b(?:is|are|was|were|has|have|had|does|do|did|shows?|presents?|contains?|includes?|uses?|provides?|reports?|describes?|demonstrates?|indicates?|suggests?|reveals?|enables?|allows?)\b)/i.test(
      text ?? ''
    )
  )
    return undefined
  if (
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+(?:ranks?|restores?|traces?)\b/i.test(text ?? '') ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+paves?\b/i.test(text ?? '') ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+[.:]\s+[^.!?]{1,48}\bpaves?\b/i.test(text ?? '') ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+further\s+compares?\b/i.test(text ?? '') ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+(?:stratifies|identifies|projects?|resolves?)\b/i.test(
      text ?? ''
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+over\s+each\s+panel(?:'s|’s)\b/i.test(text ?? '')
  )
    return undefined
  // Keep an unpunctuated title such as "Figure 1 Outline of ..." eligible;
  // only the lower-case verb form is a running-prose reference.
  if (/^(?:[Ff]ig(?:ure)?\.?)\s+[A-Z]?\d+\s+outlines\b/.test(text ?? '')) return undefined
  // Lowercase figure references can continue directly into a sentence after a
  // conjunction (for example, "fig. 6 and the same whole-domain error").
  // This is body prose, while a combined caption normally uses a colon or
  // punctuation-delimited title after the label.
  if (/^fig\.\s+[A-Z]?\d+\s+and\s+(?:the|same|this|these|those|our|their|its)\b/i.test(text ?? ''))
    return undefined
  if (/^(?:Table|Tab\.?)\s+[A-Z]?\d+\s+confirms?\b/i.test(text ?? '')) return undefined
  if (/^(?:Table|Tab\.?)\s+[A-Z]?\d+\s+we\s+(?:see|study|evaluate|report)\b/i.test(text ?? ''))
    return undefined
  if (
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+and\s+reference\s+scores?\s+in\s+(?:Table|Tab\.?)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  // A bracketed citation followed by a sentence opener is an inline body
  // reference (for example, "Fig. 1 [30]. The two tasks ..."), not a caption.
  if (
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+\[\d+(?:\s*[-,]\s*\d+)*\]\.\s+(?:The|This|These|Those|Our|Their|It|They)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  // A label followed by an adverb and a finite verb is still running prose
  // when PDF extraction keeps the reference at the start of a line (for
  // example, "Fig. 4 qualitatively compares ...").  Restrict this guard to
  // adverbs ending in -ly and the irregular "likewise" so noun-phrase captions
  // such as "Figure 4 visual comparison ..." remain eligible.
  const adverbNarrativeReference = new RegExp(
    `^(?:(?:Supplementary|Supplemental)\\s+)?(?:Fig\\.?|Figure|Chart)\\s+(?:[A-Z]?\\d+(?:\\.\\d+)?|[A-Z]\\.\\d+|[IVXLCDM]+)${narrativeReferencePanel}\\s+(?:[a-z]+ly|likewise)\\s+${narrativeReferenceVerb}\\b`,
    'i'
  )
  if (adverbNarrativeReference.test(text ?? '')) return undefined
  // Generated-figure index rows can begin with a figure number followed by a
  // source filename. They are metadata prose, not figure captions.
  if (
    /^(?:Fig(?:ure)?\.?\s*[A-Z]?\d+(?:\.\d+)?)\s+(?:[\w-]+\s+)*[\w-]+\.(?:py|ipynb|js|jsx|ts|tsx|json|ya?ml|csv|tex|sh|r|jl|m)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  if (/^fig\d+\s+.+\.(?:py|ipynb|js|jsx|ts|tsx|json|ya?ml|csv|tex|sh|r|jl|m)\b/i.test(text ?? ''))
    return undefined
  if (
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+(?:draws?|places?|dissects?|magnifies?|puts?|sits?|sitting)\b/i.test(
      text ?? ''
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+and\s+(?:briefly\s+)?(?:describe|discuss|compare|summari[sz]e|explain|outline)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  // Sentence-level transitions after a punctuated label are running prose,
  // not caption titles (for example, "Fig. 4. First, the situation ...").
  if (
    /^(?:Fig\.?|Figure)\s+(?:[A-Z]?\d+|[IVXLCDM]+)\s*\.\s+(?:First|Second|Third|However|Therefore|Thus|Meanwhile|Additionally|Moreover)\s*,/i.test(
      text ?? ''
    )
  )
    return undefined
  // A bare label followed by a relative clause is an inline reference when
  // extraction starts the sentence at the label (for example, "Figure 5 where
  // the bounding box ...").  Punctuation-delimited captions remain eligible.
  const relativeClauseReference = new RegExp(
    `^${narrativeReferenceLabel}${narrativeReferencePanel}\\s+(?:where|which|that)\\b`,
    'i'
  )
  if (relativeClauseReference.test(text ?? '')) return undefined
  // Letter-suffixed panel references can be followed by a prose opener after
  // a period (for example, "Figure 7b. For pie charts ...").  Keep ordinary
  // panel captions such as "Figure 7b. Accuracy by chart type" eligible.
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*[A-Za-z][.:]\s+(?:For|In|As|When|Where|Since|Because|The|This|These|Our)\b(?=[\s\S]*\b(?:is|are|was|were|has|have|had|does|do|did|shows?|presents?|contains?|includes?|uses?|provides?|reports?|passes?)\b)/i.test(
      text ?? ''
    )
  )
    return undefined
  // OCR/table-row extraction can put a data row behind a label-like token
  // (for example, "Table 77-81 82.2 ...").  A continuation made entirely of
  // numeric values and separators is data, not a descriptive caption.
  // Parse the label separately so a nonnumeric suffix cannot make the engine
  // repartition one long run of values into exponentially many token groups.
  const numericRowTail = /^\s+[\d.,:%()+/–—-][\d.,:%()+/–—\s-]*$/
  const integerRowLabel = /^(?:Table|Tab\.?|Figure|Fig\.?)\s+[A-Z]?\d+/i.exec(text)
  if (integerRowLabel) {
    const tail = text.slice(integerRowLabel[0].length)
    if (numericRowTail.test(tail)) return undefined
    const ordinalRange = /^\s*[-–—]\s*[A-Z]?\d+/i.exec(tail)
    if (ordinalRange && numericRowTail.test(tail.slice(ordinalRange[0].length))) return undefined
  }
  // Decimal-looking table labels followed only by numeric values are common
  // extracted data rows (for example, "Table 82.9 82.2 86.3 ..."), not
  // descriptive captions. Handle the decimal label before the general row
  // guard, whose first ordinal intentionally accepts only integers.
  const decimalRowLabel = /^(?:Table|Tab\.?)\s+[A-Z]?\d+\.\d+/i.exec(text)
  if (decimalRowLabel && numericRowTail.test(text.slice(decimalRowLabel[0].length)))
    return undefined
  // Some references repeat the kind only once and use a bare second ordinal
  // ("Table 3 and 4, where ...").  Require a prose continuation after a
  // comma so a real combined caption such as "Table 3 and 4: Results" stays
  // eligible.
  if (
    /^(?:Table|Tab\.?)\s+[A-Z]?\d+\s+and\s+[A-Z]?\d+\s*,\s*(?:where|which|that|as|while|respectively)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  // Appendix cross-reference indexes can start with a figure label followed by
  // shorthand and a "Main text"/"Supp. Table" destination. These are table
  // cells, not captions, even though they begin with a printed figure number.
  if (
    /^(?:Figure|Fig\.?)\s+[A-Z]?\d+\s+[A-Z]{1,8}\s+\d+.*\b(?:Main text|Supp(?:lementary)?\.?\s+Table)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  // Supplementary index tables may omit the "Main text" destination while
  // retaining an SM method number and a list of supplementary tables/figures.
  if (
    /^(?:Figure|Fig\.?)\s+[A-Z]?\d+\s+SM\s+\d+.*\bSupp(?:lementary)?\.?\s+(?:Tables?|Figs?\.?|Figures?)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  // A symbol immediately after a printed label usually belongs to a table
  // footnote continuation (for example, "Table 9. † means ..."), not a new
  // caption heading.
  if (/^(?:Table|Tab\.?|Figure|Fig\.?)\s+[A-Z]?\d+[.:]\s+[†‡*#]/i.test(text ?? '')) return undefined
  // Lowercase, unnumbered "table."/"figure." lines are usually sentence
  // continuations from body prose rather than captions.  Preserve the
  // explicit uppercase form handled below for single-table manuscripts.
  if (
    /^table[.:]\s+(?:Subsequently|The|This|These|Those|In|As|For|When|Where|Since|Because|Also|Moreover|Additionally|Furthermore|Overall)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  if (
    /^(?:fig\.?|figure)[.:]\s+(?:For|In|As|When|Where|Since|Because|To|The|This|These|Those|However|Therefore|Thus)\b/.test(
      text ?? ''
    )
  )
    return undefined
  if (
    /^(?:fig\.?|figure)\s+[A-Z]?\d+[.:]\s+(?:For|In|As|When|Where|Since|Because|To|The|This|These|Those|However|Therefore|Thus)\b/.test(
      text ?? ''
    )
  )
    return undefined
  if (unpunctuatedFigureReference) return undefined
  if (
    /^figure[.:]\s+[A-Z][A-Z\s-]+,\s+(?:however|therefore|thus|meanwhile|additionally|moreover)\b/.test(
      text ?? ''
    )
  )
    return undefined
  // Some IEEE captions are split from a sentence after the label and begin
  // with a short proper subject ("Fig. 4. ASTER exhibits ...").  Requiring a
  // capitalized subject and a finite verb keeps ordinary noun titles such as
  // "Figure 1. Plot of the results" eligible.
  const subjectNarrativeReference = new RegExp(
    `^${narrativeReferenceLabel}${narrativeReferencePanel}\\s*\\.\\s+(?!(?:there|the|this|these|those|our|their|its|it|they|a|an)\\b)\\p{Lu}[\\p{L}\\p{N}-]*\\s+${narrativeReferenceVerb}\\s+\\p{L}(?=\\s|[.,;:!?]|$)`,
    'iu'
  )
  if (subjectNarrativeReference.test(text ?? '')) return undefined
  if (
    /^(?:Table|Tab\.?)\s+[IVXLCDM]+\s*\.\s+\p{Lu}[\p{L}\p{N}-]*\s+(?:achieves?|reports?|shows?|indicates?|describes?)\b/iu.test(
      text ?? ''
    )
  )
    return undefined
  if (/^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s*\.\s+Results\s+use\b/i.test(text ?? '')) return undefined
  // A panel list followed by a closing parenthesis is another common inline
  // form ("Fig. 4 (b) and (c)). The adapter ...").  It has no caption title;
  // reject it without affecting the normal "Figure 4. (A) ..." heading.
  if (
    new RegExp(
      `^${narrativeReferenceLabel}\\s+\\([A-Za-z]\\)(?:\\s*(?:,|and|&)\\s*\\([A-Za-z]\\))*\\)+\\.`,
      'i'
    ).test(text ?? '')
  )
    return undefined
  if (
    /^(?:Table|Chart|Fig\.?|Figure)\s+[A-Z]?\d+(?:\s+and\s+(?:(?:Supplementary|Supplemental)\s+)?(?:Table|Chart|Fig\.?|Figure)\s+[A-Z]?\d+)?\s+(?:shows?|shown|presents?|presented|compares?|compared(?=\s+(?:the|these|those|this|that|our)\b)|illustrat(?:es?|ed)|visuali[sz](?:es?|ed)|plots|gives?|follows?|depict(?:s|ed)?|represents?|reiterates?|reviews|summari[sz](?:e(?:s|d)?|ing)|indicates?|suggests?|describes?|demonstrates?)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  // Some appendices label the diagram directly instead of assigning a figure number.
  if (/^Appendix\s+[A-Z][.:]\s+(?:CONSORT\s+)?(?:flow diagram|flowchart)\.?$/i.test(text ?? ''))
    return 'figure'
  // Single-table articles can use an explicit label without a sequence number.
  const unnumbered = /^(Table|Figure)[.:]\s+/i.exec(text)
  if (unnumbered && /^\p{Lu}\p{L}/u.test(text.slice(unnumbered[0].length)))
    return unnumbered[1].toLowerCase() === 'table' ? 'table' : 'figure'
  if (/^(?:Figure|Fig\.?)\s+[A-Z]?\d+\s*[—–-]\s*Continued\.?$/i.test(text)) return 'figure'
  if (/^Figure\s+(?:[n▪■]\s+)?(?:Flow diagram|Flowchart)\b/.test(text ?? '')) return 'figure'
  // Pathology journals use decorated Image labels; a closing marker followed
  // by a period is an inline reference, not a caption heading.
  if (/^(?:❚Image\s+\d+❚\s+[A-Z]|Image\s+\d+[.:]\s+)/.test(text ?? '')) return 'figure'
  if (/^(?:Table|Fig\.?|Figure)\s*\(\d+\)\s*[:.]/i.test(text ?? ''))
    return /^Table/i.test(text) ? 'table' : 'figure'
  if (/^(?:Fig\.?|Figure)\s+\d+[A-Z]$/i.test(text)) return 'figure'
  if (/^(?:Fig\.?|Figure)\s+\d+\.?[A-Z](?:[-–][A-Z])?[.:](?:\s|$)/i.test(text ?? ''))
    return 'figure'
  // An adjacent pipe is an explicit supplementary title delimiter, not an
  // arithmetic bar or a second ordinal. Keep the ordinary prose guards above.
  const supplementaryPipe = /^((?:Fig\.?|Figure)\s+S\d+)\|(?=\s+\p{Lu}\p{L})/u.exec(text ?? '')
  if (supplementaryPipe)
    return captionKind(`${supplementaryPipe[1]}:${text.slice(supplementaryPipe[0].length)}`)
  if (/^(?:Table|Tab\.)\s+[IVXLCDM]+(?=[\s.:：．、]|$)/i.test(text ?? '')) return 'table'
  // Czech and Slovak publishers use this explicit abbreviation for figures.
  if (/^Obr\.\s*\d+(?=[\s.:]|$)/i.test(text)) return 'figure'
  if (/^(?:Supplementary|Supplemental) Table(?: \(online only\))?\.\s+\p{Lu}/u.test(text))
    return 'table'
  if (/^Box\s+\d+[.:]\s+\p{Lu}/u.test(text)) return 'table'
  // A letter suffix identifies a separate table, while a dash can delimit the
  // title without whitespace. Require a title after the delimiter so ranges
  // and inline references do not become captions.
  const dashed =
    /^(Table|TABLE|Tab\.|TAB\.|Figure|FIGURE|Fig\.?|FIG\.?)\s+[A-Z]?\d+[A-Z]?\s*[—–-]\s*\p{Lu}/u.exec(
      text ?? ''
    )
  if (dashed) return /^(?:Table|Tab\.)$/i.test(dashed[1]) ? 'table' : 'figure'
  const match =
    /^(?:(?:Supplementary|Supplemental|Supplement|Extended\s+Data)\s+)?(F\s*I\s*G\s*U\s*R\s*E|F\s*I\s*G\.?|C\s*H\s*A\s*R\s*T|T\s*A\s*B\s*L\s*E|T\s*A\s*B\.?|图|圖|表)\s*[A-Z]?\d+(?:[.-]\d+)*(?=[\s.:：．、。]|$)/i.exec(
      text ?? ''
    )
  return match
    ? /^(?:Table|Tab\.?|表)$/i.test(match[1].replace(/\s/g, ''))
      ? 'table'
      : 'figure'
    : undefined
}

// Keep the original lines separately. A visible line-end hyphen can be reflowed
// only when an independent, unbroken spelling occurs on the same source page;
// competing hyphenated spellings retain the original text.
export function sourceWordSpellings(texts) {
  return new Set(
    texts.flatMap((text) =>
      (text.toLowerCase().match(/\p{L}+(?:[-\u2010\u2011]\p{L}+)*/gu) ?? []).map((word) =>
        word.replace(/[\u2010\u2011]/g, '-')
      )
    )
  )
}

export function hasWitnessedLineEndHyphen(text, next, pageWords) {
  const prefix = /(\p{L}+)[-\u2010\u2011]$/u.exec(text)?.[1]
  const suffix = /^(\p{Ll}+)/u.exec(next)?.[1]
  return !!(
    prefix &&
    suffix &&
    pageWords?.has((prefix + suffix).toLowerCase()) &&
    !pageWords.has((prefix + '-' + suffix).toLowerCase())
  )
}

export function joinCaptionLines(lines, pageWords) {
  return lines.reduce((text, line) => {
    const next = line.trim()
    if (!next) return text
    if (text.endsWith('\u00ad')) return text.slice(0, -1) + next
    if (hasWitnessedLineEndHyphen(text, next, pageWords)) return text.slice(0, -1) + next
    return text + (text && !/[-\u2010\u2011]$/.test(text) ? ' ' : '') + next
  }, '')
}

// A first-line indent is distinct from a hanging legend. Require an unfinished
// opening line and either repeated paragraph edges or a short grammatical tail.
// Callers still establish ownership (caption label or table-note evidence).
export function findOutdentedParagraphContinuation(start, lines) {
  if (start.text.length < 35 || /[.!?:]$/.test(start.text.trim())) return
  return lines.find(
    (line) =>
      line.y > start.y + 2 &&
      line.y - start.y <= start.fontSize * 1.6 &&
      start.x - line.x >= start.fontSize * 0.6 &&
      start.x - line.x <= start.fontSize * 1.8 &&
      Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
      line.right <= start.right + 2 &&
      line.text.length >= 10 &&
      !captionKind(line.text) &&
      ((/\b(?:of|and|the|with|for|in|to)$/i.test(start.text.trim()) && /[.!?]$/.test(line.text)) ||
        // A semicolon-separated glossary can end with one short definition.
        (/;\s*$/.test(start.text) &&
          /(?:^|[;:]\s*)[A-Z][A-Z0-9/.-]{1,10},\s*\p{L}/u.test(start.text) &&
          /^[A-Z][A-Z0-9/.-]{1,10},\s*\p{L}[^;]+\.$/u.test(line.text)) ||
        (Math.abs(line.right - start.right) <= 2 &&
          lines.some(
            (next) =>
              next.y > line.y + 2 &&
              next.y - line.y <= start.fontSize * 1.6 &&
              Math.abs(next.x - line.x) <= 2 &&
              Math.abs(next.fontSize - start.fontSize) <= 0.7 &&
              next.right <= start.right + 2 &&
              next.text.length >= 15 &&
              !captionKind(next.text)
          )))
  )
}

// A narrow floating table can share a source baseline with unrelated prose.
// Preserve its native title column only when a pipe-delimited label, closed
// continuation, three aligned borders and independently printed header/record
// rows all identify the same small table. Ordinary same-font gutters stay as-is.
function nativeFramedFloatCaptionLines(page, rules) {
  const protectedLines = new Set()
  for (const start of page.lines.filter(
    (line) => /^Table\s+\d+\s+\|\s+\p{L}/u.test(line.text) && line.text.length <= 90
  )) {
    const em = start.fontSize
    if (!(em > 0)) continue
    const borders = rules.length
      ? rules.filter((r) => r[1] === r[3]).map((r) => [...r])
      : (page.graphicsBounds ?? [])
          .filter((graphic) => graphic.kind === 'path')
          .map((graphic) =>
            graphic.normalizedRect.map(
              (value, axis) => value * (axis % 2 ? page.height : page.width)
            )
          )
    const nearby = borders
      .filter(
        (r) =>
          r.length === 4 &&
          r.every(Number.isFinite) &&
          r[3] - r[1] >= 0 &&
          r[3] - r[1] <= em &&
          r[2] - r[0] >= em * 8 &&
          r[2] - r[0] <= page.width * 0.45 &&
          Math.abs(r[0] - start.x) <= em * 0.4 &&
          start.x + start.width <= r[2] + em * 0.5 &&
          r[1] >= start.y + start.height - em * 0.1 &&
          r[3] <= start.y + em * 10
      )
      .sort((a, b) => a[1] - b[1])
    const frames = nearby
      .filter(
        (r, index) =>
          !nearby
            .slice(0, index)
            .some(
              (before) =>
                Math.abs(before[0] - r[0]) <= em * 0.1 && Math.abs(before[2] - r[2]) <= em * 0.1
            )
      )
      .map((first) =>
        nearby.filter(
          (r) => Math.abs(first[0] - r[0]) <= em * 0.1 && Math.abs(first[2] - r[2]) <= em * 0.1
        )
      )
      .filter((frame) => frame.length === 3)
    const proofs = []
    for (const [opening, divider, closing] of frames) {
      if (
        opening[1] - start.y > em * 3.5 ||
        divider[1] - opening[3] < em ||
        closing[1] - divider[3] < em
      )
        continue
      const title = page.lines
        .filter(
          (line) =>
            line.y >= start.y - em * 0.1 &&
            line.y + line.height <= opening[1] + em * 0.1 &&
            Math.abs(line.x - start.x) <= em * 0.1 &&
            Math.abs(line.fontSize - em) <= em * 0.03 &&
            line.x + line.width <= opening[2] + em * 0.5
        )
        .sort((a, b) => a.y - b.y)
      if (
        title[0] !== start ||
        title.length < 2 ||
        title.length > 4 ||
        !/[.!?]$/.test(title.at(-1).text.trim()) ||
        title
          .slice(1)
          .some(
            (line, index) =>
              captionKind(line.text) ||
              line.y - title[index].y < em ||
              line.y - title[index].y > em * 1.5
          )
      )
        continue
      const neighboring = title.map((line) =>
        page.lines.filter(
          (body) =>
            body !== line &&
            body.text.length >= 25 &&
            body.x < line.x - em * 10 &&
            Math.abs(body.y - line.y) <= 2 &&
            Math.abs(body.fontSize - em) <= em * 0.03 &&
            line.x - body.x - body.width >= -em * 0.05 &&
            line.x - body.x - body.width <= em * 0.8
        )
      )
      if (
        neighboring.some((lines) => lines.length !== 1) ||
        neighboring.some(([line]) => Math.abs(line.x - neighboring[0][0].x) > em * 0.1)
      )
        continue
      const inside = page.lines.filter(
        (line) => line.x >= opening[0] - em * 0.1 && line.x + line.width <= opening[2] + em * 0.1
      )
      const headers = inside.filter(
        (line) =>
          line.y >= opening[1] && line.y + line.height <= divider[1] && /\p{L}/u.test(line.text)
      )
      const separateHeaders = headers.some((line) =>
        headers.some(
          (other) =>
            other !== line &&
            Math.abs(line.y - other.y) <= 2 &&
            other.x - line.x - line.width >= em * 0.1
        )
      )
      const records = inside
        .filter(
          (line) =>
            line.y >= divider[1] &&
            line.y + line.height <= closing[1] + em * 0.1 &&
            line.width >= (opening[2] - opening[0]) * 0.8 &&
            line.text.length >= 10
        )
        .sort((a, b) => a.y - b.y)
      if (
        !separateHeaders ||
        records.length < 2 ||
        records.some(
          (line, index) =>
            Math.abs(line.x - records[0].x) > em * 0.1 ||
            Math.abs(line.fontSize - records[0].fontSize) > em * 0.03 ||
            (index &&
              (line.y - records[index - 1].y < em * 0.8 ||
                line.y - records[index - 1].y > em * 1.5))
        )
      )
        continue
      proofs.push(title)
    }
    if (proofs.length === 1) for (const line of proofs[0]) protectedLines.add(line)
  }
  return protectedLines
}

export function groupPageLines(page, rules = [], origins) {
  const rows = []
  const framedFloatCaptionLines = nativeFramedFloatCaptionLines(page, rules)
  // A narrow algorithm gutter can be smaller than the generic fragment join.
  // Repeated aligned numbered instructions prove a separate source column;
  // ordinary numerical fields or a single inline reference do not.
  const algorithmSteps = page.lines.filter((line) =>
    /^\d+:\s+(?:end\s+(?:for|while|if)|(?:for|while|if|return|store)\b)/i.test(line.text.trim())
  )
  const separateSteps = new Set(
    algorithmSteps.filter(
      (line) =>
        algorithmSteps.filter(
          (other) =>
            Math.abs(line.x - other.x) < line.fontSize * 0.1 &&
            Math.abs(line.fontSize - other.fontSize) < line.fontSize * 0.05
        ).length >= 3
    )
  )
  // Two side-by-side tables can start on the same baseline. Their captions
  // often end and begin within one nominal font-size gutter, so the generic
  // fragment join below would merge the two labels into one candidate. Keep
  // independently numbered caption labels in separate runs; ordinary title
  // fragments still use the existing measured-gutter rule.
  const startsCaptionLabel = (text) =>
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Table|Tab\.?|Figure|Fig\.?)\s+(?:[A-Z]?\d+(?:[.-]\d+)*|[A-Z][.-]\d+(?:\.\d+)*|[IVXLCDM]+)(?=[\s.:：．、。]|$)/i.test(
      text.trim()
    )
  // Join nearby fragments on the same visual line, including superscripts split by the first probe.
  for (const line of page.lines
    .filter((line) => !/^[◂◀◃]$/.test(line.text.trim()))
    .sort((a, b) => a.y - b.y || a.x - b.x)) {
    assert([line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite))
    const row = rows.find((entry) => Math.abs(entry.y - line.y) <= 2)
    if (row) row.parts.push(line)
    else rows.push({ y: line.y, parts: [line] })
  }
  const runs = []
  let captionColumns = []
  let captionColumnsY = -Infinity
  // A raised numeric reference or lowered subscript can sit outside the normal line tolerance.
  // Require text tightly adjoining both sides on one baseline, rather than
  // widening that tolerance and absorbing the next physical line.
  for (const row of rows) {
    for (const part of [...row.parts]) {
      if (
        !/^(?:[\p{L}\d]{1,5},?|\d[\d–−/∞ h]{1,7}|\d+(?:[.,]\d+)?\s*[A-Za-z]{1,3})$/u.test(part.text)
      )
        continue
      const target = rows.find((other) => {
        if (other === row) return false
        const before = other.parts.find((p) => Math.abs(part.x - p.x - p.width) <= p.fontSize * 0.2)
        const after = other.parts.find(
          (p) => Math.abs(p.x - part.x - part.width) <= p.fontSize * 0.4
        )
        return (
          before &&
          after &&
          part.fontSize <= before.fontSize * 0.8 &&
          Math.abs(before.y - after.y) <= 1 &&
          Math.abs(before.fontSize - after.fontSize) <= 0.5 &&
          ((part.y > before.y + 2 &&
            part.y + part.height > before.y + before.height &&
            part.y + part.height - before.y - before.height <= before.fontSize * 0.5) ||
            (/^\d+$/.test(part.text) &&
              part.y < before.y &&
              before.y + before.height - part.y - part.height >= before.fontSize * 0.2 &&
              before.y + before.height - part.y - part.height <= before.fontSize * 0.8))
        )
      })
      if (target) {
        row.parts.splice(row.parts.indexOf(part), 1)
        target.parts.push({ ...part, inlineSubscript: part.y > target.y })
      }
    }
  }
  for (const row of rows) {
    const captionStarts = row.parts
      .filter((part) => startsCaptionLabel(part.text))
      .sort((a, b) => a.x - b.x)
    if (captionStarts.length >= 2) {
      captionColumns = captionStarts.map((part) => ({ x: part.x, right: part.x + part.width }))
      captionColumnsY = row.y
    }
    const activeCaptionColumns =
      captionColumns.length >= 2 &&
      row.y - captionColumnsY <= Math.max(...row.parts.map((part) => part.fontSize)) * 5
        ? captionColumns
        : []
    let run
    let previous
    let runColumn = -1
    let runFramedFloatCaption = false
    for (const part of row.parts.sort((a, b) => a.x - b.x)) {
      const partColumn =
        activeCaptionColumns.length >= 2
          ? activeCaptionColumns.reduce(
              (index, column, candidate) => (part.x >= column.x ? candidate : index),
              0
            )
          : -1
      const separateCaptionLabels =
        run && runColumn >= 0 && partColumn >= 0 && runColumn !== partColumn
      // Geometry only: permit nearby fragments, but do not bridge a typical column gutter.
      // A narrow gutter or unusually wide within-caption gap still needs layout-level evidence.
      if (
        run &&
        !separateCaptionLabels &&
        runFramedFloatCaption === framedFloatCaptionLines.has(part) &&
        !(separateSteps.has(part) && part.x - run.right > part.fontSize * 0.5) &&
        part.x - run.right <= Math.max(run.fontSize, part.fontSize) * 0.8
      ) {
        // Preserve numeric superscripts in the shared plain-text result. A smaller font alone
        // is not evidence: require a raised baseline and tight attachment to preceding text.
        const rise = run.bottom - (part.y + part.height)
        const superscript =
          /^\d+$/.test(part.text) &&
          part.fontSize <= run.fontSize * 0.8 &&
          rise >= run.fontSize * 0.2 &&
          rise <= run.fontSize * 0.8 &&
          part.x - run.right >= -run.fontSize * 0.1 &&
          part.x - run.right <= run.fontSize * 0.3
        origins?.get(run)?.push(part)
        run.text += superscript
          ? part.text.replace(/\d/g, (digit) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)])
          : (part.inlineSubscript ||
            (previous?.inlineSubscript && part.x - run.right <= part.fontSize * 0.2)
              ? ''
              : ' ') + part.text
        run.y = Math.min(run.y, part.y)
        run.right = Math.max(run.right, part.x + part.width)
        run.bottom = Math.max(run.bottom, part.y + part.height)
        run.fontSize = Math.max(run.fontSize, part.fontSize)
      } else {
        run = {
          text: part.text,
          x: part.x,
          y: part.y,
          right: part.x + part.width,
          bottom: part.y + part.height,
          fontSize: part.fontSize
        }
        origins?.set(run, [part])
        runs.push(run)
        runColumn = partColumn
        runFramedFloatCaption = framedFloatCaptionLines.has(part)
      }
      previous = part
    }
  }
  if (origins instanceof Map) rememberNativeGroupedCaptionRuns(page, rules, origins, runs)
  return runs
}

// A PDF stream may omit EOL between prose and a numbered caption in the other
// column. Invisible spacing tokens must not bridge that physical gutter.
export function startsDetachedTableCaption(pending, item) {
  const previous = pending.findLast((i) => i.str.trim())
  // A complete native figure-caption item may follow another column's body
  // at nearly the same baseline. Preserve that original item boundary when
  // a physical gutter, smaller distinct font and its own line ending agree.
  // This separates source lines only; graphic ownership is still proved later.
  if (
    previous &&
    previous.str.trim().length > 24 &&
    !captionKind(previous.str) &&
    /^(?:Fig\.?|Figure)\s+(?:[A-Z]?\d+(?:\.\d+)*|[A-Z][.-]\d+)[.:]\s+\p{L}/iu.test(
      item.str.trim()
    ) &&
    item.hasEOL === true &&
    previous.fontName &&
    item.fontName &&
    previous.fontName !== item.fontName &&
    [previous, item].every(
      (part) =>
        part.transform?.length === 6 &&
        [...part.transform, part.width, part.height].every(Number.isFinite) &&
        part.transform[0] > 0 &&
        part.transform[1] === 0 &&
        part.transform[2] === 0 &&
        part.transform[3] > 0 &&
        part.width > 0 &&
        part.height > 0
    ) &&
    item.height >= previous.height * 0.8 &&
    item.height <= previous.height * 0.95 &&
    previous.transform[5] - item.transform[5] >= 0 &&
    previous.transform[5] - item.transform[5] <= previous.height * 0.2 &&
    Math.max(
      item.transform[4] - previous.transform[4] - previous.width,
      previous.transform[4] - item.transform[4] - item.width
    ) > previous.height
  )
    return true
  return Boolean(
    previous &&
    /^(?:Table(?:\s+\d+)?|(?:Fig\.?|Figure)\s+\d+[.:]?)$/i.test(item.str.trim()) &&
    previous.transform[1] === 0 &&
    item.transform[1] === 0 &&
    Math.max(
      item.transform[4] - previous.transform[4] - previous.width,
      previous.transform[4] - item.transform[4] - item.width
    ) >
      Math.max(previous.height, item.height) * 2
  )
}

// Auxiliary pages have native geometry but no inference/operator-rule pass.
// Quantized thin path bounds provide the same opening-bar witness for a bare
// table label; leave requested pages and every other caption unchanged.
export function recoverAuxiliaryTableCaptions(pages, candidates, requestedPages) {
  return candidates.map((candidate) => {
    if (
      requestedPages.includes(candidate.page) ||
      candidate.lines.length !== 1 ||
      !/^Table\s+\d+$/i.test(candidate.lines[0].trim())
    )
      return candidate
    const page = pages.find((p) => p.pageNumber === candidate.page)
    if (!page) return candidate
    const rules = (page.graphicsBounds ?? [])
      .filter((g) => g.kind === 'path')
      .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
      .filter(
        (r) =>
          r[3] - r[1] <= page.height / 64 &&
          r[2] - r[0] >= page.width * 0.5 &&
          r[2] - r[0] > (r[3] - r[1]) * 15
      )
      .map((r) => [r[0], (r[1] + r[3]) / 2, r[2], (r[1] + r[3]) / 2])
    if (!rules.length) return candidate
    const bounded = findCaptionCandidates([page], new Map([[page.pageNumber, rules]])).find(
      (c) =>
        c.lines.length === 2 &&
        c.lines[0] === candidate.lines[0] &&
        Math.abs(c.rect[0] - candidate.rect[0]) < 0.01 &&
        c.rect[1] === candidate.rect[1]
    )
    return bounded ?? candidate
  })
}

// A single-spaced paragraph can end on a centered native row. Repeated full
// baselines and independent painted ownership prove the whole finite block;
// neither a short centered sentence nor its wording is sufficient.
function findNativeSingleSpacedCaptionParagraph(start, runs, page, rules) {
  const kind = captionKind(start.text),
    em = start.fontSize
  if (!['figure', 'table'].includes(kind) || start.text.length < 35 || !(em > 0)) return
  const valid = (l) =>
    [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) && l.width > 0 && l.height > 0
  const source = page.lines.filter(
    (l) =>
      l.text.trim() &&
      valid(l) &&
      l.y >= start.y - em * 0.9 &&
      l.y < start.y + em * 24 &&
      l.x >= start.x - em * 0.05 &&
      l.x + l.width <= start.right + em * 0.1
  )
  const ordinary = source
    .filter((l) => Math.abs(l.fontSize - em) < em * 0.01)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const baselines = []
  for (const part of ordinary) {
    const row = baselines.at(-1)
    if (row && Math.abs(row.y - part.y) < em * 0.1) row.parts.push(part)
    else baselines.push({ y: part.y, parts: [part] })
  }
  const rows = [],
    orphan = []
  let leading
  for (const baseline of baselines) {
    if (baseline.parts.every((p) => p.text.trim().length <= 2)) {
      orphan.push(...baseline.parts)
      continue
    }
    const parts = [...baseline.parts].sort((a, b) => a.x - b.x)
    const row = {
      y: baseline.y,
      parts,
      x: parts[0].x,
      right: Math.max(...parts.map((p) => p.x + p.width)),
      text: parts.map((p) => p.text).join(' ')
    }
    const edgeFragments = source.filter(
      (p) =>
        p.fontSize >= em * 0.5 &&
        p.fontSize <= em * 0.8 &&
        parts.some(
          (base) =>
            Math.abs(p.x - base.x - base.width) < em * 0.1 &&
            p.y - base.y >= -em * 0.9 &&
            p.y - base.y <= em * 0.9
        )
    )
    row.right = Math.max(row.right, ...edgeFragments.map((p) => p.x + p.width))
    const previous = rows.at(-1)
    if (!previous) {
      if (
        Math.abs(row.y - start.y) > em * 0.05 ||
        Math.abs(row.x - start.x) > em * 0.05 ||
        !start.text.startsWith(parts[0].text)
      )
        return
    } else {
      const gap = row.y - previous.y
      if (
        gap < em * 0.95 ||
        gap > em * 1.4 ||
        (leading && Math.abs(gap - leading) > em * 0.03) ||
        (captionKind(row.text) &&
          !(
            /^(?:Fig\.?|Figure|Tab\.?|Table)\s+[A-Z]?\d+(?:\.\d+)*[.:]/iu.test(row.text) &&
            /\b(?:and|by|for|from|in|of|to|with)$/iu.test(previous.text.trim())
          )) ||
        /^Notes?\s*[:.]/iu.test(row.text)
      )
        break
      leading ??= gap
      const terminal =
        rows.length >= 2 &&
        /[.!?]$/u.test(row.text.trim()) &&
        (!/[.!?]$/u.test(previous.text.trim()) ||
          (Math.abs(row.x - start.x) < em * 0.05 && /^and\b/iu.test(previous.text.trim()))) &&
        row.right - row.x >= em * 3 &&
        row.right - row.x < (start.right - start.x) * 0.98 &&
        (Math.abs(row.x + row.right - start.x - start.right) < em * 0.04 ||
          (Math.abs(row.x - start.x) < em * 0.05 &&
            row.right - row.x < (start.right - start.x) * 0.8))
      if (terminal) {
        rows.push(row)
        break
      }
      if (Math.abs(row.x - start.x) > em * 0.05 || Math.abs(row.right - start.right) > em * 0.1)
        break
    }
    rows.push(row)
  }
  if (rows.length < 3) return
  const last = rows.at(-1),
    previous = rows.at(-2),
    leftTerminal =
      /[.!?]$/u.test(last.text.trim()) &&
      Math.abs(last.x - start.x) < em * 0.05 &&
      last.right - last.x < (start.right - start.x) * 0.8
  if (
    !/[.!?]$/u.test(last.text.trim()) ||
    (/[.!?]$/u.test(previous.text.trim()) &&
      !(leftTerminal && /^and\b/iu.test(previous.text.trim()))) ||
    (!leftTerminal && last.x - start.x <= em * 0.2) ||
    (!leftTerminal && Math.abs(last.x + last.right - start.x - start.right) >= em * 0.04)
  )
    return
  const selected = new Set(rows.flatMap((row) => row.parts))
  const small = source.filter((l) => l.fontSize >= em * 0.5 && l.fontSize <= em * 0.8)
  for (const part of [...small, ...orphan]) {
    if (part.y + part.height < start.y || part.y > last.y + em) continue
    // Full native edge attachment must select one physical baseline. A
    // closest-baseline guess would move a lowered item into the next row.
    const parents = rows.flatMap((row, index) =>
      row.parts
        .filter(
          (base) =>
            Math.abs(base.fontSize - em) < em * 0.01 &&
            Math.abs(part.x - base.x - base.width) < em * 0.1 &&
            part.y - base.y >= -em * 0.9 &&
            part.y - base.y <= em * 0.9
        )
        .map((base) => ({ index, base }))
    )
    if (parents.length !== 1 || selected.has(part)) return
    rows[parents[0].index].parts.push(part)
    selected.add(part)
  }
  for (const row of rows) {
    row.parts.sort((a, b) => a.x - b.x || a.y - b.y)
    if (
      row.parts.some(
        (p, i) => i && p.x - Math.max(...row.parts.slice(0, i).map((q) => q.x + q.width)) > em * 0.8
      )
    )
      return
    row.text = row.parts.map((p) => p.text).join(' ')
    row.bottom = Math.max(...row.parts.map((p) => p.y + p.height))
    row.fontSize = em
  }
  const bottom = Math.max(...rows.map((row) => row.bottom))
  const glyphs = (text) => [...text.replace(/\s/gu, '')].sort().join('')
  // The caller retains its original first grouped row. Do not prove a new
  // paragraph if doing so would silently omit a first-row source fragment.
  if (glyphs(rows[0].text) !== glyphs(start.text)) return
  if (
    page.lines.some(
      (l) =>
        l.text.trim() &&
        !selected.has(l) &&
        (!valid(l) ||
          (l.x < start.right &&
            l.x + l.width > start.x &&
            l.y < bottom &&
            l.y + l.height > start.y))
    )
  )
    return
  if (kind === 'figure') {
    const bounds = [
      ...new Map(
        (page.graphicsBounds ?? [])
          .filter((g) => ['path', 'image'].includes(g.kind))
          .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
          .filter(
            (r) =>
              r.every(Number.isFinite) &&
              r[2] > r[0] &&
              r[3] > r[1] &&
              r[0] >= start.x - em &&
              r[2] <= start.right + em &&
              r[3] <= start.y &&
              start.y - r[3] < em * 6 &&
              r[2] - r[0] >= em * 3 &&
              (r[2] - r[0]) * (r[3] - r[1]) >= page.width * page.height * 0.01
          )
          .map((r) => [r.join(','), r])
      ).values()
    ]
    const owners = bounds.filter(
      (r) =>
        !bounds.some(
          (other) =>
            other !== r &&
            other[0] <= r[0] &&
            other[1] <= r[1] &&
            other[2] >= r[2] &&
            other[3] >= r[3]
        )
    )
    const alignedOwners =
      owners.length >= 2 &&
      owners.every(
        (r) => Math.abs(r[1] - owners[0][1]) < em * 0.1 && Math.abs(r[3] - owners[0][3]) < em * 0.1
      ) &&
      owners.every((r, i) =>
        owners.every(
          (other, j) => i === j || r[2] <= other[0] + em * 0.1 || other[2] <= r[0] + em * 0.1
        )
      )
    const singleOwner =
      owners.length === 1 && owners[0][2] - owners[0][0] >= (start.right - start.x) * 0.5
    if (
      (!singleOwner && !alignedOwners) ||
      runs.some(
        (l) =>
          l !== start &&
          !selected.has(l) &&
          l.x < start.right &&
          l.right > start.x &&
          l.y >= owners[0][3] &&
          l.bottom <= start.y &&
          (captionKind(l.text) || (l.text.length >= 30 && l.fontSize >= em * 0.8))
      )
    )
      return
  } else {
    const horizontal = [
      ...new Map(
        rules
          .filter(
            (r) =>
              r.length === 4 &&
              r.every(Number.isFinite) &&
              r[1] === r[3] &&
              r[2] - r[0] >= (start.right - start.x) * 0.9 &&
              Math.abs(r[0] + r[2] - start.x - start.right) < em &&
              r[1] < start.y &&
              start.y - r[1] < em * 16
          )
          .map((r) => [r.join(','), r])
      ).values()
    ].sort((a, b) => a[1] - b[1])
    if (
      horizontal.length !== 3 ||
      start.y - horizontal[2][1] > em * 2 ||
      horizontal[2][1] - horizontal[0][1] < em * 2 ||
      horizontal.some(
        (r) =>
          Math.abs(r[0] - horizontal[0][0]) > em * 0.05 ||
          Math.abs(r[2] - horizontal[0][2]) > em * 0.05
      )
    )
      return
    const side = (edge) => {
      const walls = rules
        .filter(
          (r) =>
            r.length === 4 &&
            r.every(Number.isFinite) &&
            r[0] === r[2] &&
            Math.abs(r[0] - edge) < em * 0.05 &&
            r[1] >= horizontal[0][1] - em * 0.05 &&
            r[3] <= horizontal[2][1] + em * 0.05
        )
        .sort((a, b) => a[1] - b[1])
      let end = horizontal[0][1]
      for (const wall of walls) {
        if (wall[1] - end > em * 0.05) return false
        end = Math.max(end, wall[3])
      }
      return horizontal[2][1] - end < em * 0.05
    }
    if (!side(horizontal[0][0]) || !side(horizontal[0][2])) return
  }
  return rows.slice(1)
}

// A double-spaced caption may be centered or hang after its label. Require
// a native graphic/border and repeated physical paragraph geometry before
// bypassing the ordinary line-leading gate. The final line closes the block.
function findNativeMathCaptionParagraph(start, runs, page, rules) {
  if (captionKind(start.text) !== 'figure' || start.text.length < 35) return
  const em = start.fontSize,
    edge = Math.max(
      start.right,
      ...runs
        .filter(
          (l) =>
            Math.abs(l.x - start.x) < em * 0.3 &&
            Math.abs(l.fontSize - em) < 0.1 &&
            l.y >= start.y &&
            l.y - start.y < em * 20
        )
        .map((l) => l.right)
    )
  const source = page.lines
    .filter(
      (l) =>
        l.text.trim() &&
        Math.abs(l.fontSize - em) < 0.1 &&
        l.y >= start.y - em * 0.15 &&
        l.y - start.y < em * 30 &&
        l.x >= start.x - em * 0.3 &&
        l.x + l.width <= edge + em * 0.1
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = []
  for (const part of source) {
    const row = rows.at(-1)
    if (row && Math.abs(row.y - part.y) < em * 0.1) row.parts.push(part)
    else rows.push({ y: part.y, parts: [part] })
  }
  const owned = [],
    radicals = []
  for (const row of rows) {
    const parts = row.parts.sort((a, b) => a.x - b.x),
      text = parts.map((l) => l.text).join(' '),
      previous = owned.at(-1)
    // A closed short row followed by extra paragraph leading is a native
    // ownership boundary. Scripts in the following body cannot prove math
    // ownership for the caption that has already ended.
    if (
      owned.length >= 2 &&
      /[.!?]$/.test(previous.text.trim()) &&
      previous.right - previous.x < (edge - start.x) * 0.8 &&
      row.y - previous.y > previous.y - owned.at(-2).y + em * 0.2
    )
      break
    if (
      parts.every((l) => l.text.trim().length <= 2) &&
      row.y - (previous?.y ?? start.y) < em * 0.9
    )
      continue
    if (
      parts.every((l) => l.text.trim().length <= 2) &&
      parts[0].x > start.x + em * 0.5 &&
      rows.some(
        (r) =>
          r.y > row.y &&
          r.y - row.y < em &&
          r.parts.some((p) => p.text.length > 2 && Math.abs(p.x - start.x) < em * 0.3)
      )
    )
      continue
    const adjoiningRadicals = page.lines.filter(
      (l) =>
        l.text.trim() === '√' &&
        Math.abs(l.fontSize - em) < em * 0.01 &&
        Math.abs(l.x - start.x) < em * 0.3 &&
        Math.abs(l.x + l.width - parts[0].x) < em * 0.05 &&
        row.y - l.y >= em * 0.25 &&
        row.y - l.y <= em * 0.9 &&
        l.y + l.height > row.y &&
        source.filter(
          (p) =>
            p.text.trim().length > 2 &&
            Math.abs(l.x + l.width - p.x) < em * 0.05 &&
            p.y - l.y >= em * 0.25 &&
            p.y - l.y <= em * 0.9 &&
            l.y + l.height > p.y
        ).length === 1
    )
    const radical = adjoiningRadicals.length === 1 ? adjoiningRadicals[0] : undefined
    const prefix =
      !!radical ||
      page.lines.some(
        (l) =>
          l.text.trim() &&
          l.x >= start.x - em * 0.3 &&
          l.x <= start.x + em * 0.3 &&
          l.x + l.width <= parts[0].x + em * 0.1 &&
          Math.abs(l.y - row.y) < em &&
          ((l.fontSize <= em * 0.8 &&
            rules.some(
              (r) =>
                r[1] === r[3] &&
                r[2] - r[0] < em * 2 &&
                r[0] <= l.x + em * 0.1 &&
                r[2] >= l.x + l.width - em * 0.1 &&
                Math.abs(r[1] - row.y) < em
            )) ||
            (l.text.trim().length === 1 &&
              Math.abs(l.fontSize - em) < 0.1 &&
              Math.abs(l.x + l.width - parts[0].x) < em * 0.05 &&
              l.y + l.height > row.y))
      )
    if (!previous) {
      if (Math.abs(row.y - start.y) > em * 0.15 || Math.abs(parts[0].x - start.x) > em * 0.3) return
    } else if (
      row.y - previous.y < em * 0.85 ||
      row.y - previous.y > em * 1.8 ||
      (captionKind(text) && !/^(?:Table|Fig\.?|Figure)\s+\d+\.?$/i.test(text.trim())) ||
      /^Notes?\s*[:.]/i.test(text) ||
      (Math.abs(parts[0].x - start.x) > em * 0.3 && !(prefix && parts[0].x - start.x < em * 2))
    )
      break
    const bridged = parts.every((part, i) => {
      if (!i) return true
      const before = parts[i - 1],
        left = before.x + before.width
      if (part.x - left <= em * 0.8) return true
      const pieces = page.lines
        .filter(
          (l) =>
            l.text.trim() &&
            l.x >= left - em * 0.1 &&
            l.x + l.width <= part.x + em * 0.1 &&
            l.y + l.height > row.y &&
            l.y < row.y + em &&
            ((l.fontSize >= em * 0.5 && l.fontSize <= em * 0.8) ||
              (l.text.trim().length === 1 &&
                Math.abs(l.fontSize - em) < 0.1 &&
                Math.abs(l.x + l.width - part.x) < em * 0.05))
        )
        .sort((a, b) => a.x - b.x)
      if (
        !pieces.length ||
        pieces.some(
          (p, n) =>
            n && Math.abs(p.x - pieces[n - 1].x) < 0.01 && Math.abs(p.y - pieces[n - 1].y) < 0.01
        )
      )
        return false
      let end = left
      for (const p of pieces) {
        if (p.x - end > em * 0.8) return false
        end = Math.max(end, p.x + p.width)
      }
      return part.x - end <= em * 0.8
    })
    if (!bridged) return
    const captured = runs
      .filter(
        (l) =>
          Math.abs(l.y - row.y) < em * 0.3 &&
          Math.abs(l.fontSize - em) < 0.1 &&
          l.x <= parts[0].x + 0.1 &&
          l.right >= parts[0].x + parts[0].width - 0.1
      )
      .sort((a, b) => b.right - b.x - a.right + a.x)[0]
    const retained = captured
      ? captured.text +
        ' ' +
        parts
          .filter((l) => l.x >= captured.right - 0.1 && !captured.text.includes(l.text.trim()))
          .map((l) => l.text)
          .join(' ')
      : text
    if (radical) radicals.push(radical)
    owned.push({
      text: (radical && !retained.includes(radical.text)
        ? radical.text + ' ' + retained
        : retained
      ).trim(),
      x: Math.min(start.x, parts[0].x, radical?.x ?? Infinity),
      y: row.y,
      right: Math.max(...parts.map((l) => l.x + l.width)),
      bottom: Math.max(
        ...parts.map((l) => l.y + l.height),
        radical ? radical.y + radical.height : -Infinity
      ),
      fontSize: em
    })
  }
  if (owned.length < 3 || !/[.!?]$/.test(owned.at(-1).text.trim())) return
  const math = page.lines.filter(
    (l) =>
      l.y >= start.y &&
      l.y <= owned.at(-1).bottom &&
      l.x >= start.x - em * 0.3 &&
      l.x + l.width <= edge + em * 0.1 &&
      l.fontSize <= em * 0.8
  )
  if (math.length < 2) {
    if (radicals.length !== 1 || owned.length < 5) return
    const whole = page.lines.filter(
      (l) =>
        l.text.trim() &&
        l.y + l.height > start.y &&
        l.y < owned.at(-1).bottom &&
        l.x < edge &&
        l.x + l.width > start.x
    )
    const glyphs = (text) => [...text.replace(/\s/gu, '')].sort().join('')
    if (
      whole.some(
        (l) =>
          ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
          l.x < start.x - em * 0.3 ||
          l.x + l.width > edge + em * 0.1 ||
          (Math.abs(l.fontSize - em) >= 0.1 && !(l.fontSize >= em * 0.5 && l.fontSize <= em * 0.8))
      ) ||
      glyphs(whole.map((l) => l.text).join(' ')) !== glyphs(owned.map((l) => l.text).join(' '))
    )
      return
  }
  if (!provesFragmentedCaptionGraphic(start, runs, page, owned.at(-1))) return
  return owned.slice(1)
}

// A complete source paragraph may have a small label indent, wider uniform
// leading, or a larger first-row font. Qualify those physical layouts only
// beneath an independently painted graphic and before a distinct body block.
// The ordinary continuation and shared outdent thresholds stay unchanged.
function findNativeBoundedFigureParagraph(start, runs, page, rules) {
  const em = start.fontSize
  if (captionKind(start.text) !== 'figure' || start.text.length < 35 || !(em > 0)) return
  const valid = (l) =>
    [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) && l.width > 0 && l.height > 0
  const source = page.lines
    .filter(
      (l) =>
        valid(l) &&
        l.text.trim() &&
        l.y >= start.y - em * 0.15 &&
        l.y < Math.min(start.y + em * 24, page.height) &&
        l.x >= start.x - em * 1.8 &&
        l.x + l.width <= start.right + em * 0.5
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const next = source.find(
    (l) => l.y > start.y + em * 0.5 && l.text.trim().length >= 12 && l.fontSize >= em * 0.85
  )
  if (!next) return
  const styled = next.fontSize >= em * 0.86 && next.fontSize <= em * 0.94,
    base = styled ? next.fontSize : em
  if (!styled && Math.abs(next.fontSize - em) > em * 0.02) return
  const major = source.filter(
    (l) =>
      Math.abs(l.fontSize - base) <= em * 0.02 ||
      (styled && l.y - start.y < em * 0.2 && Math.abs(l.fontSize - em) <= em * 0.02)
  )
  const baselines = []
  for (const part of major) {
    const row = baselines.at(-1)
    if (row && Math.abs(row.y - part.y) < em * 0.12) row.parts.push(part)
    else baselines.push({ y: part.y, parts: [part] })
  }
  const outline = (row) => ({
    ...row,
    x: Math.min(...row.parts.map((p) => p.x)),
    right: Math.max(...row.parts.map((p) => p.x + p.width)),
    text: [...row.parts]
      .sort((a, b) => a.x - b.x)
      .map((p) => p.text)
      .join(' ')
  })
  const first = baselines[0] && outline(baselines[0]),
    second = baselines[1] && outline(baselines[1])
  if (!first || !second || Math.abs(first.y - start.y) > em * 0.15) return
  const indent = first.x - second.x,
    firstGap = second.y - first.y,
    smallIndent =
      !styled &&
      indent >= em * 0.25 &&
      indent < em * 0.6 &&
      firstGap >= em * 0.95 &&
      firstGap <= em * 1.4 &&
      !/[.!?:]$/u.test(start.text.trim()),
    wide = !styled && Math.abs(indent) <= em * 0.05 && firstGap >= em * 1.6 && firstGap <= em * 2.25
  if (
    (!smallIndent && !wide && !styled) ||
    (styled && (Math.abs(indent) > em * 0.1 || firstGap < em * 0.95 || firstGap > em * 1.5))
  )
    return
  const rows = [first]
  let leading
  for (const baseline of baselines.slice(1)) {
    const row = outline(baseline),
      previous = rows.at(-1),
      gap = row.y - previous.y
    const scriptTransition =
      smallIndent &&
      leading &&
      Math.abs(gap - leading) <= em * 0.2 &&
      gap >= em * 0.95 &&
      gap <= em * 1.4 &&
      source.filter(
        (p) =>
          p.fontSize >= em * 0.5 &&
          p.fontSize <= em * 0.8 &&
          row.parts.filter(
            (q) =>
              Math.abs(p.x - q.x - q.width) < em * 0.2 &&
              p.y - q.y >= -em * 0.2 &&
              p.y - q.y <= em * 0.7
          ).length === 1
      ).length === 1
    if (
      rows.length >= 24 ||
      Math.abs(row.x - second.x) > em * 0.05 ||
      row.right > start.right + em * (wide ? 0.25 : 0.1) ||
      captionKind(row.text) ||
      /^Notes?\s*[:.]/iu.test(row.text) ||
      (rows.length > 1 && Math.abs(gap - leading) > base * 0.05 && !scriptTransition) ||
      (styled && rows.length > 1 && (gap < base * 0.95 || gap > base * 1.5))
    )
      break
    if (rows.length > 1) leading ??= gap
    else if (!styled) leading = gap
    rows.push(row)
  }
  if (rows.length < (smallIndent ? 3 : 2)) return
  const last = rows.at(-1),
    edge = Math.max(start.right, ...rows.map((r) => r.right)),
    left = Math.min(start.x, second.x)
  if (rows.slice(1, -1).some((r) => r.right - r.x < (edge - left) * 0.85)) return
  const following = page.lines
    .filter(
      (l) =>
        valid(l) &&
        l.text.trim().length > 2 &&
        l.y > last.y + em * 0.2 &&
        l.x < edge &&
        l.x + l.width > left &&
        !rows.some((r) => r.parts.includes(l))
    )
    .sort((a, b) => a.y - b.y)[0]
  const bodyBoundary =
    following &&
    (Math.abs(following.fontSize - base) > em * 0.04 ||
      following.y - last.y >= (leading ?? firstGap) * 1.35)
  const below = page.lines.filter((l) => l.text.trim() && l.y > last.y + em)
  const pageEnd =
    below.length <= 1 &&
    (below.length
      ? valid(below[0]) &&
        /^(?:[A-Z]{0,2})?\d+$/u.test(below[0].text.trim()) &&
        below[0].y > page.height * 0.88 &&
        Math.abs(below[0].x + below[0].width / 2 - page.width / 2) < em * 2
      : last.y + base > page.height * 0.85)
  if (!bodyBoundary && !pageEnd) return
  // A wide-leading paragraph can close with a parenthetical definition or
  // semicolon. Punctuation alone cannot close it: require a separate vertical
  // boundary as well as the complete native paragraph and graphic proof below.
  const boundedTail =
    wide &&
    rows.length >= 3 &&
    (/[.!?]\s+\([^()]+\)$/u.test(last.text.trim()) ||
      /;$/u.test(last.text.trim()) ||
      (pageEnd &&
        last.right - last.x < (edge - left) * 0.65 &&
        /:\s+[^():]{4,}\s\(\d{4}[a-z]?\)$/u.test(last.text.trim()))) &&
    (pageEnd || (following && following.y - last.y >= (leading ?? firstGap) * 1.35))
  // A short final noun fragment need not carry punctuation when repeated
  // native leading and a separate following paragraph delimit the whole block.
  // The complete graphic and source-line proofs below still apply.
  const unpunctuatedTail =
    wide &&
    rows.length >= 3 &&
    /^[\p{Ll}][\p{L}\s-]*$/u.test(last.text.trim()) &&
    last.right - last.x < (edge - left) * 0.5 &&
    following &&
    following.y - last.y >= (leading ?? firstGap) * 2
  if (!/[.!?]$/u.test(last.text.trim()) && !boundedTail && !unpunctuatedTail) return
  const selected = new Set(rows.flatMap((r) => r.parts))
  for (const part of source) {
    if (selected.has(part) || part.y > last.y + em || part.y + part.height < start.y) continue
    if (part.fontSize < em * 0.5 || part.fontSize > base * 0.8) return
    const parents = rows.flatMap((row, index) =>
      row.parts
        .filter(
          (p) =>
            Math.abs(part.x - p.x - p.width) < em * 0.2 &&
            part.y - p.y >= -em * 0.9 &&
            part.y - p.y <= em * 0.9
        )
        .map(() => index)
    )
    // Preserve the existing left-parent interpretation. A leading native
    // digit may borrow only the uniquely adjacent following full font in
    // this already bounded paragraph; it does not create a new text row.
    if (
      parents.length === 0 &&
      /^\d{1,2}$/u.test(part.text) &&
      part.height >= part.fontSize - 1e-8
    ) {
      const following = rows.flatMap((row, index) =>
        row.parts
          .filter(
            (p) =>
              p.height >= p.fontSize - 1e-8 &&
              p.x - part.x - part.width >= -em * 0.05 &&
              p.x - part.x - part.width <= em * 0.2 &&
              part.y < p.y &&
              p.y - part.y <= em * 0.9
          )
          .map(() => index)
      )
      if (following.length === 1) parents.push(following[0])
    }
    if (parents.length !== 1) return
    rows[parents[0]].parts.push(part)
    selected.add(part)
  }
  for (const row of rows) {
    row.parts.sort((a, b) => a.x - b.x || a.y - b.y)
    if (
      row.parts.some(
        (p, i) =>
          i &&
          (p.x - Math.max(...row.parts.slice(0, i).map((q) => q.x + q.width)) > em * 0.8 ||
            row.parts.slice(0, i).some((q) => q.x === p.x && q.y === p.y))
      )
    )
      return
    row.text = row.parts.map((p) => p.text).join(' ')
    row.x = Math.min(...row.parts.map((p) => p.x))
    row.right = Math.max(...row.parts.map((p) => p.x + p.width))
    row.bottom = Math.max(...row.parts.map((p) => p.y + p.height))
    row.fontSize = em
  }
  const bottom = Math.max(...rows.map((r) => r.bottom)),
    envelope = { ...start, x: left, right: edge },
    upperFontTop =
      styled && rows.every((r) => r.parts.every((p) => p.height >= p.fontSize - 1e-8))
        ? Math.min(...rows[0].parts.map((p) => p.y))
        : undefined
  const completeStyledPanel =
    !styled ||
    !/\([a-z]\)/iu.test(start.text) ||
    (runs.some(
      (line) => line.y < start.y && /^\([a-z]\)(?:\s+\([a-z]\))*$/iu.test(line.text.trim())
    ) &&
      (() => {
        const owners = page.graphicsBounds.filter((graphic) => graphic?.kind === 'image')
        const operationIndexes = owners
          .map((graphic) => graphic.operationIndex)
          .filter(Number.isFinite)
        return (
          operationIndexes.length === 0 ||
          new Set(operationIndexes).size === operationIndexes.length
        )
      })())
  if (
    page.lines.some(
      (l) =>
        l.text.trim() &&
        !selected.has(l) &&
        (!valid(l) ||
          (l.x < edge && l.x + l.width > left && l.y < bottom && l.y + l.height > start.y))
    ) ||
    rules.some(
      (r) =>
        r[1] === r[3] && r[1] > start.y && r[1] < bottom && r[0] <= left + em && r[2] >= edge - em
    ) ||
    !completeStyledPanel ||
    (!provesSingleCaptionRaster(envelope, runs, page, upperFontTop) &&
      !provesFragmentedCaptionGraphic(envelope, runs, page, last, wide ? 1.05 : 0.98, 0.025))
  )
    return
  const glyphs = (text) => [...text.replace(/\s/gu, '')].sort().join('')
  const firstGlyphs = glyphs(rows[0].text),
    startGlyphs = glyphs(start.text)
  if ([...startGlyphs].some((g) => firstGlyphs.split(g).length < startGlyphs.split(g).length))
    return
  return { first: rows[0], tail: rows.slice(1) }
}

// An isolated raster caption can wrap at an uppercase acronym. Its complete
// native block must repeat the same pitch without any sentence/paragraph break.
function provesRegularIsolatedCaption(start, runs, page) {
  if (captionKind(start.text) !== 'figure') return false
  const em = start.fontSize
  const images = (page.graphicsBounds ?? []).filter((graphic) => graphic.kind === 'image')
  if (images.length !== 1 || page.graphicsBounds.length !== 1) return false
  const image = images[0].normalizedRect
  if (
    !Array.isArray(image) ||
    image.length !== 4 ||
    !image.every(Number.isFinite) ||
    image[2] <= image[0] ||
    image[3] <= image[1] ||
    (image[2] - image[0]) * (image[3] - image[1]) <= 0.08 ||
    image[3] * page.height > start.y + page.height / 256 ||
    start.y - image[3] * page.height > em * 6 ||
    image[0] * page.width >= start.right ||
    image[2] * page.width <= start.x ||
    runs.some((line) => line.y < start.y && line.y >= page.height * 0.07)
  )
    return false
  const block = runs.filter((line) => line.y >= start.y).sort((a, b) => a.y - b.y)
  if (block.length < 3 || block[0] !== start || !/[.!?]$/.test(block.at(-1).text.trim()))
    return false
  const pitch = block[1].y - start.y
  return (
    pitch > em * 1.6 &&
    pitch <= em * 1.8 &&
    block.every(
      (line, index) =>
        Math.abs(line.x - start.x) <= 2 &&
        Math.abs(line.fontSize - em) < em * 0.015 &&
        (!index || !captionKind(line.text)) &&
        (!index || Math.abs(line.y - block[index - 1].y - pitch) < em * 0.1) &&
        (index === block.length - 1 || !/[.!?]$/.test(line.text.trim()))
    )
  )
}

// Centered publisher prose has a stable native center, not a stable left
// edge. Require a complete connected block and its independently painted
// graphic; neither indentation nor a closed sentence alone proves ownership.
function provesSingleCaptionRaster(start, runs, page, upperFontTop) {
  const em = start.fontSize
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image')
    .map((g) => {
      const envelope = g.imageEnvelopeNormalizedRect
      const qualified =
        Number.isFinite(upperFontTop) &&
        /^[a-f0-9]{64}$/u.test(g.imageHash ?? '') &&
        envelope?.length === 4 &&
        envelope.every(Number.isFinite) &&
        envelope[2] > envelope[0] &&
        envelope[3] > envelope[1] &&
        g.normalizedRect?.length === 4 &&
        g.normalizedRect.every(Number.isFinite) &&
        envelope.every(
          (v, i) =>
            v >= 0 && v <= 1 && (i < 2 ? v >= g.normalizedRect[i] : v <= g.normalizedRect[i])
        )
      return {
        qualified,
        rect: (qualified ? envelope : g.normalizedRect).map(
          (v, axis) => v * (axis % 2 ? page.height : page.width)
        )
      }
    })
    .filter(
      ({ rect: r, qualified }) =>
        r.every(Number.isFinite) &&
        r[0] >= start.x - em &&
        r[2] <= start.right + em &&
        r[1] < r[3] &&
        r[2] > r[0] &&
        r[3] <= (qualified ? upperFontTop : start.y + em * 0.1) &&
        start.y - r[3] < em * 6 &&
        (r[2] - r[0]) * (r[3] - r[1]) > page.width * page.height * 0.04 &&
        r[2] - r[0] > (start.right - start.x) * 0.5
    )
  if (images.length !== 1) return false
  const image = images[0].rect
  if (
    images[0].qualified &&
    runs.some(
      (line) =>
        line.text.trim() &&
        line.y < upperFontTop &&
        line.bottom > image[3] &&
        line.x < start.right &&
        line.right > start.x
    )
  )
    return false
  return !runs.some(
    (line) =>
      line !== start &&
      line.text.length >= 30 &&
      line.fontSize >= em * 0.8 &&
      line.y >= image[3] - em * 0.1 &&
      line.bottom <= start.y &&
      line.x < start.right &&
      line.right > start.x
  )
}

// Two centered rows need complete native rows and independent graphic/body
// boundaries. A closed first sentence can continue with the next panel label.
function findNativeShortCenteredCaption(start, runs, page, rules) {
  const em = start.fontSize,
    valid = (r) =>
      r &&
      typeof r.text === 'string' &&
      [r.x, r.y, r.right, r.bottom, r.fontSize].every(Number.isFinite) &&
      r.right > r.x &&
      r.bottom > r.y &&
      r.fontSize > 0
  if (
    !valid(start) ||
    !Array.isArray(page.lines) ||
    !Array.isArray(page.graphicsBounds) ||
    ![page.width, page.height].every(Number.isFinite) ||
    page.width <= 0 ||
    page.height <= 0 ||
    page.invalidGraphicsBounds !== 0 ||
    captionKind(start.text) !== 'figure' ||
    start.text.length < 35
  )
    return
  const following = runs
    .filter((r) => r.y > start.y + em * 0.5 && r.x < start.right && r.right > start.x)
    .sort((a, b) => a.y - b.y)
  const tail = following[0]
  if (
    !valid(tail) ||
    tail.y - start.y < em ||
    tail.y - start.y > em * 2 ||
    Math.abs(tail.fontSize - em) > em * 0.015 ||
    captionKind(tail.text) ||
    /^Notes?\s*[:.]/iu.test(tail.text) ||
    tail.right - tail.x >= (start.right - start.x) * 0.8 ||
    tail.right - tail.x < em * 3 ||
    tail.x <= start.x ||
    tail.right >= start.right ||
    Math.abs((tail.x + tail.right - start.x - start.right) / 2) > em * 0.05
  )
    return
  const after = following[1],
    leading = tail.y - start.y
  if (/[.!?]$/u.test(start.text.trim())) {
    const previousPanel = [...start.text.matchAll(/\(([a-z])\)/gu)].at(-1)?.[1],
      nextPanel = /^\(([a-z])\)\s/u.exec(tail.text)?.[1]
    if (!previousPanel || !nextPanel || nextPanel.charCodeAt(0) !== previousPanel.charCodeAt(0) + 1)
      return
  }
  if (
    after &&
    (!valid(after) ||
      after.y - tail.bottom < em ||
      (after.y - tail.y < leading * 1.35 && after.fontSize < em * 1.1))
  )
    return
  if (!after && tail.bottom < page.height * 0.7) return
  if (
    !/[.!?]$/u.test(tail.text.trim()) &&
    !(after && after.fontSize >= em * 1.1 && tail.text.length >= 30)
  )
    return
  const native = page.lines.filter(
    (l) =>
      l.text?.trim() &&
      l.x < start.right &&
      l.x + l.width > start.x &&
      l.y < tail.bottom &&
      l.y + l.height > start.y
  )
  if (
    native.length !== 2 ||
    native.some(
      (l) =>
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
        l.width <= 0 ||
        l.height <= 0 ||
        Math.abs(l.fontSize - em) > em * 0.015 ||
        l.height < l.fontSize - 0.02 ||
        ![start, tail].some(
          (r) =>
            l.text === r.text &&
            Math.abs(l.y - r.y) < 0.02 &&
            Math.abs(l.x - r.x) < 0.02 &&
            Math.abs(l.x + l.width - r.right) < 0.02
        )
    )
  )
    return
  if (
    rules.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        (r[1] < tail.bottom && r[3] > start.y && r[0] < start.right && r[2] > start.x)
    )
  )
    return
  if (
    (page.graphicsBounds ?? []).some((g) => {
      if (
        !g ||
        !['image', 'path'].includes(g.kind) ||
        !Array.isArray(g.normalizedRect) ||
        g.normalizedRect.length !== 4 ||
        !g.normalizedRect.every(Number.isFinite) ||
        g.normalizedRect.some((v) => v < 0 || v > 1) ||
        g.normalizedRect[2] <= g.normalizedRect[0] ||
        g.normalizedRect[3] <= g.normalizedRect[1]
      )
        return true
      const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      return r[0] < start.right && r[2] > start.x && r[1] < tail.bottom && r[3] > start.bottom
    })
  )
    return
  const titled = { ...start, text: start.text.replace(/^Fig\.(?=\d)/u, 'Fig. ') }
  // A centered caption may be narrower than its raster. Require an independent,
  // uniquely centered image before using its width for the existing ownership
  // check; do not loosen the shared raster proof for other caption layouts.
  const centeredImages = page.graphicsBounds.filter((g) => {
    if (g.kind !== 'image') return false
    const [left, top, right, bottom] = g.normalizedRect.map(
      (v, i) => v * (i % 2 ? page.height : page.width)
    )
    return (
      Math.abs((left + right - start.x - start.right) / 2) <= em * 0.25 &&
      right - left >= start.right - start.x &&
      right - left <= (start.right - start.x) * 1.25 &&
      top < bottom &&
      bottom <= start.y &&
      start.y - bottom < em * 6
    )
  })
  const centeredRaster =
    centeredImages.length === 1 &&
    provesSingleCaptionRaster(
      {
        ...start,
        x: centeredImages[0].normalizedRect[0] * page.width,
        right: centeredImages[0].normalizedRect[2] * page.width
      },
      runs,
      page
    )
  if (
    !provesSingleCaptionRaster(start, runs, page) &&
    !centeredRaster &&
    ((!rules.length && !/^Fig\.\d/iu.test(start.text.trim())) ||
      !provesFragmentedCaptionGraphic(titled, runs, page, tail))
  )
    return
  return [tail]
}

function findNativeCenteredFigureParagraph(start, runs, page) {
  if (captionKind(start.text) !== 'figure' || start.text.length < 35) return
  const em = start.fontSize,
    center = (start.x + start.right) / 2,
    rows = [start]
  const following = runs
    .filter((line) => line.y > start.y + 2 && line.y - start.y < em * 24)
    .sort((a, b) => a.y - b.y)
  for (const line of following) {
    if (Math.abs((line.x + line.right) / 2 - center) > em * 0.15) continue
    const previous = rows.at(-1)
    if (
      line.y - previous.y < em * 0.85 ||
      line.y - previous.y > em * 1.65 ||
      Math.abs(line.fontSize - em) > em * 0.015 ||
      captionKind(line.text) ||
      /^Notes?\s*[:.]/i.test(line.text)
    )
      break
    rows.push(line)
    const width = Math.max(...rows.map((r) => r.right)) - Math.min(...rows.map((r) => r.x))
    if (/[.!?]$/.test(line.text.trim()) && line.right - line.x < width * 0.8) break
  }
  if (
    rows.length < 3 ||
    !/[.!?]$/.test(rows.at(-1).text.trim()) ||
    !rows.some((line) => Math.abs(line.x - start.x) > em * 0.25)
  )
    return
  const envelope = {
    ...start,
    x: Math.min(...rows.map((line) => line.x)),
    right: Math.max(...rows.map((line) => line.right))
  }
  if (
    !provesSingleCaptionRaster(envelope, runs, page) &&
    !provesFragmentedCaptionGraphic(envelope, runs, page, rows.at(-1))
  )
    return
  return rows.slice(1)
}

// A same-font wrapped reference can be an interior row of a figure caption.
// Its complete paragraph needs an aligned full-width run, an independent
// graphic above, and a short closed tail or a separate larger section below.
function findNativeInternalReferenceParagraph(start, runs, page, rules) {
  const em = start.fontSize,
    valid = (line) =>
      line &&
      typeof line.text === 'string' &&
      [line.x, line.y, line.right, line.bottom, line.fontSize].every(Number.isFinite) &&
      line.right > line.x &&
      line.bottom > line.y &&
      line.fontSize > 0
  if (
    !valid(start) ||
    captionKind(start.text) !== 'figure' ||
    start.text.length < 35 ||
    !/\b(?:in|from)$/iu.test(start.text.trim()) ||
    !Array.isArray(runs) ||
    !Array.isArray(rules) ||
    !Array.isArray(page.lines) ||
    !Array.isArray(page.graphicsBounds) ||
    page.invalidGraphicsBounds !== 0 ||
    ![page.width, page.height].every(Number.isFinite) ||
    !(page.width > 0 && page.height > 0)
  )
    return
  const following = runs
    .filter((line) => line.y > start.y + 2 && line.x < start.right && line.right > start.x)
    .sort((a, b) => a.y - b.y)
  const first = following[0]
  // A printed colon title may wrap an interior reference followed by another
  // sentence. A full-width ending needs an independent section boundary;
  // ordinary reference paragraphs still require their existing short tail.
  const label = /^(?:Fig\.?|Figure)\s+([A-Z]?\d+(?:\.\d+)*)[.:]/u,
    firstLabel = first?.text.match(label),
    startLabel = start.text.match(label),
    sectionReference = !!(
      /^Figure\s+[A-Z]?\d+(?:\.\d+)*:\s/u.test(start.text) &&
      firstLabel &&
      startLabel &&
      firstLabel[1] !== startLabel[1] &&
      /^Figure\s+[A-Z]?\d+(?:\.\d+)*\.\s+\p{Lu}/u.test(first.text)
    )
  if (
    !valid(first) ||
    (!sectionReference && !/^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+with\b/u.test(first.text))
  )
    return
  const leading = first.y - start.y,
    tail = []
  let reference = false
  if (leading < em || leading > em * 1.5) return
  for (const row of following) {
    const prior = tail.at(-1) ?? start
    if (
      !valid(row) ||
      Math.abs(row.fontSize - em) > em * 0.015 ||
      Math.abs(row.x - start.x) > em * 0.1 ||
      row.right > start.right + em * 0.1 ||
      Math.abs(row.y - prior.y - leading) > em * 0.1 ||
      row.y - start.y > em * 12 ||
      (captionKind(row.text) &&
        (!/\b(?:in|from|to)$/iu.test(prior.text.trim()) ||
          !/^(?:Fig\.?|Figure|Table|Tab\.)\s+[A-Z]?\d+(?:\.\d+)*(?:[.:]\s+|\s+with\b)/u.test(
            row.text
          )))
    )
      break
    if (captionKind(row.text)) reference = true
    tail.push(row)
    if (/[.!?]$/u.test(row.text.trim()) && row.right - row.x < (start.right - start.x) * 0.8) break
  }
  if (
    !reference ||
    tail.length < 2 ||
    tail.length > 10 ||
    !/[.!?]$/u.test(tail.at(-1).text.trim()) ||
    (!sectionReference && tail.at(-1).right - tail.at(-1).x >= (start.right - start.x) * 0.8) ||
    tail.slice(0, -1).some((line) => line.right - line.x < (start.right - start.x) * 0.8)
  )
    return
  const last = tail.at(-1),
    rows = [start, ...tail],
    bbox = [start.x, start.y, start.right, Math.max(...rows.map((line) => line.bottom))],
    native = page.lines.filter(
      (line) =>
        typeof line?.text === 'string' &&
        line.text.trim() &&
        line.x < bbox[2] &&
        line.x + line.width > bbox[0] &&
        line.y < bbox[3] &&
        line.y + line.height > bbox[1]
    )
  if (
    native.length !== rows.length ||
    native.some(
      (line) =>
        ![line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite) ||
        line.width <= 0 ||
        line.height < line.fontSize - 0.02 ||
        line.fontSize <= 0 ||
        line.x < bbox[0] - em * 0.1 ||
        line.x + line.width > bbox[2] + em * 0.1 ||
        line.y < bbox[1] ||
        line.y + line.height > bbox[3] + 1e-8 ||
        !rows.some((row) => row.text === line.text && Math.abs(row.y - line.y) < 0.02)
    )
  )
    return
  const after = following.find((line) => line.y > last.y + 0.02)
  const directReference =
    /\b(?:in|from)$/iu.test(start.text.trim()) &&
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+with\b/u.test(first.text)
  if (
    sectionReference &&
    (!valid(after) ||
      !/^(?:[A-Z]|\d+(?:\.\d+)*)\s+\p{Lu}[\p{L}\s-]{4,80}$/u.test(after.text) ||
      rows.some((r) => r.right - r.x < (start.right - start.x) * 0.9) ||
      after.y - bbox[3] < em * 1.5)
  )
    return
  if (
    !valid(after) ||
    after.y - bbox[3] < em * (directReference ? 1 : 1.5) ||
    after.fontSize < em * (directReference ? 1.15 : 1.1)
  )
    return
  if (
    rules.some(
      (rule) =>
        !Array.isArray(rule) ||
        rule.length !== 4 ||
        !rule.every(Number.isFinite) ||
        (rule[1] >= start.y && rule[1] <= bbox[3] && rule[0] < bbox[2] && rule[2] > bbox[0])
    ) ||
    page.graphicsBounds.some((graphic) => {
      if (
        !graphic ||
        !['image', 'path'].includes(graphic.kind) ||
        !Array.isArray(graphic.normalizedRect) ||
        graphic.normalizedRect.length !== 4 ||
        !graphic.normalizedRect.every(Number.isFinite)
      )
        return true
      const rect = graphic.normalizedRect.map(
        (value, i) => value * (i % 2 ? page.height : page.width)
      )
      return rect[0] < bbox[2] && rect[2] > bbox[0] && rect[1] < bbox[3] && rect[3] > bbox[1]
    }) ||
    !provesFragmentedCaptionGraphic(start, runs, page, last, sectionReference ? 1 : 0.95)
  )
    return
  return tail
}

// Independently closed Left/Right source paragraphs share one uniquely owned
// raster; they do not relax the existing A/B panel or general paragraph gates.
function findNativeDirectionalPanelCaptionParagraph(start, runs, page, rules = []) {
  if (
    !start ||
    !Array.isArray(runs) ||
    !Array.isArray(page?.lines) ||
    !Array.isArray(page?.graphicsBounds) ||
    !Array.isArray(rules)
  )
    return
  const em = start.fontSize
  const valid = (row) =>
    row &&
    typeof row.text === 'string' &&
    row.text.trim() &&
    [row.x, row.y, row.right, row.bottom, row.fontSize].every(Number.isFinite) &&
    row.right > row.x &&
    row.bottom > row.y &&
    row.fontSize > 0
  if (
    !valid(start) ||
    ![page.width, page.height].every(Number.isFinite) ||
    page.width <= 0 ||
    page.height <= 0 ||
    !/^(?:Figure|Fig\.)\s+[A-Z]?\d+(?:[.-]\d+)*\.\s+Left panel:\s+\p{Lu}|^(?:Figure|Fig\.)\s+[A-Z]?\d+(?:[.-]\d+)*\.\s+Left panel:\s+\p{Ll}/u.test(
      start.text
    )
  )
    return
  const rows = runs
    .filter(
      (row) =>
        row.y > start.y && row.y < start.y + em * 14 && row.x < start.right && row.right > start.x
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const rightIndex = rows.findIndex((row) => /^Right panel:\s+\p{Lu}/u.test(row.text ?? ''))
  if (rightIndex < 1 || rightIndex > 2) return
  const left = [start, ...rows.slice(0, rightIndex)]
  if (
    left.some(
      (row, i) =>
        !valid(row) ||
        (i && captionKind(row.text)) ||
        Math.abs(row.fontSize - em) > 1e-7 ||
        Math.abs(row.x - start.x) > em * 0.2
    ) ||
    !/[.!?]$/u.test(left.at(-1).text.trim())
  )
    return
  const leading = left[1].y - start.y
  if (
    leading < em * 1.15 ||
    leading > em * 1.3 ||
    left.slice(1).some((row, i) => Math.abs(row.y - left[i].y - leading) > em * 0.03)
  )
    return
  const first = rows[rightIndex],
    gap = first.y - left.at(-1).y
  if (
    gap - leading < em * 0.3 ||
    gap - leading > em * 0.75 ||
    Math.abs(first.x - start.x) > em * 0.2 ||
    Math.abs(first.right - start.right) > em * 0.2
  )
    return
  const right = []
  for (const row of rows.slice(rightIndex)) {
    const previous = right.at(-1)
    if (
      !valid(row) ||
      captionKind(row.text) ||
      /^Notes?\s*[:.]/iu.test(row.text) ||
      (previous && /^(?:Left|Right) panel:/u.test(row.text)) ||
      Math.abs(row.fontSize - em) > 1e-7 ||
      row.bottom - row.y < em - 1e-7 ||
      row.x < start.x - em * 0.2 ||
      row.right > start.right + em * 0.2 ||
      (previous && Math.abs(row.y - previous.y - leading) > em * 0.03)
    )
      return
    if (right.length >= 6) return
    right.push(row)
    if (row.right - row.x < (start.right - start.x) * 0.65 && /[.!?]$/u.test(row.text.trim())) break
  }
  if (right.length < 3 || right.length > 6) return
  const last = right.at(-1),
    center = (start.x + start.right) / 2
  if (
    !/[.!?]$/u.test(last.text.trim()) ||
    last.right - last.x >= (start.right - start.x) * 0.65 ||
    Math.abs((last.x + last.right) / 2 - center) > em * 0.3 ||
    right
      .slice(0, -1)
      .some(
        (row) =>
          row.right - row.x < (start.right - start.x) * 0.9 || Math.abs(row.x - start.x) > em * 0.25
      )
  )
    return
  const expected = [...left, ...right],
    rect = [start.x, start.y, start.right, last.bottom]
  if (rect[2] - rect[0] < page.width * 0.5 || rect[2] > page.width - rect[0] + em * 0.2) return
  const intersect = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const native = []
  for (const source of page.lines) {
    if (!source || typeof source.text !== 'string') return
    if (!source.text.trim()) continue
    if (
      ![source.x, source.y, source.width, source.height, source.fontSize].every(Number.isFinite) ||
      source.width <= 0 ||
      source.height <= 0 ||
      source.fontSize <= 0
    )
      return
    const box = [source.x, source.y, source.x + source.width, source.y + source.height]
    if (!intersect(box, rect)) continue
    if (
      box[0] < rect[0] - em * 0.2 ||
      box[2] > rect[2] + em * 0.2 ||
      box[1] < rect[1] - 1e-7 ||
      box[3] > rect[3] + 1e-7 ||
      source.height < source.fontSize - 1e-7
    )
      return
    const owners = expected.filter(
      (row) =>
        row.text === source.text &&
        Math.abs(row.x - source.x) <= 1e-7 &&
        Math.abs(row.y - source.y) <= 1e-7 &&
        Math.abs(row.right - box[2]) <= 1e-7 &&
        Math.abs(row.bottom - box[3]) <= 1e-7 &&
        Math.abs(row.fontSize - source.fontSize) <= 1e-7
    )
    if (owners.length !== 1 || native.includes(owners[0])) return
    native.push(owners[0])
  }
  if (native.length !== expected.length || expected.some((row) => !native.includes(row))) return
  if (
    runs.some(
      (row) =>
        valid(row) &&
        row.y >= last.bottom &&
        row.y - last.bottom < leading * 1.5 &&
        row.x < rect[2] &&
        row.right > rect[0]
    )
  )
    return
  for (const rule of rules)
    if (
      !Array.isArray(rule) ||
      rule.length !== 4 ||
      !rule.every(Number.isFinite) ||
      (rule[1] >= rect[1] && rule[1] <= rect[3] && rule[0] < rect[2] && rule[2] > rect[0])
    )
      return
  const images = []
  for (const graphic of page.graphicsBounds) {
    if (
      !graphic ||
      !['image', 'path'].includes(graphic.kind) ||
      !Array.isArray(graphic.normalizedRect) ||
      graphic.normalizedRect.length !== 4 ||
      !graphic.normalizedRect.every(Number.isFinite) ||
      graphic.normalizedRect.some((v) => v < 0 || v > 1)
    )
      return
    const raw = graphic.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
    if (raw[2] <= raw[0] || raw[3] <= raw[1] || intersect(raw, rect)) return
    const painted = graphic.paintedNormalizedRect
    if (
      painted !== undefined &&
      (!Array.isArray(painted) ||
        painted.length !== 4 ||
        !painted.every(Number.isFinite) ||
        painted.some((v, i) =>
          i < 2 ? v < graphic.normalizedRect[i] : v > graphic.normalizedRect[i]
        ) ||
        painted[2] <= painted[0] ||
        painted[3] <= painted[1])
    )
      return
    const box = (painted ?? graphic.normalizedRect).map(
      (v, i) => v * (i % 2 ? page.height : page.width)
    )
    if (
      graphic.kind === 'image' &&
      box[3] <= start.y &&
      start.y - box[3] <= em * 1.5 &&
      box[2] - box[0] >= (rect[2] - rect[0]) * 0.9 &&
      box[0] >= rect[0] - em &&
      box[2] <= rect[2] + em &&
      (box[2] - box[0]) * (box[3] - box[1]) >= page.width * page.height * 0.04
    )
      images.push({ graphic, box })
  }
  if (images.length !== 1) return
  const image = images[0].box
  if (
    runs.some(
      (row) =>
        row !== start &&
        valid(row) &&
        row.bottom <= start.y &&
        row.y >= image[3] &&
        row.x < rect[2] &&
        row.right > rect[0]
    )
  )
    return
  return expected.slice(1)
}

// A single taller inline font can raise a row's top while its native bottom
// remains on the same repeated baseline. Require the whole bounded paragraph,
// exactly one interior outlier and one independently painted raster above it.
function findNativeUniformBaselineCaption(start, runs, page, rules) {
  const em = start.fontSize
  const valid = (r) =>
    r &&
    typeof r.text === 'string' &&
    [r.x, r.y, r.right, r.bottom, r.fontSize].every(Number.isFinite) &&
    r.right > r.x &&
    r.bottom > r.y &&
    r.fontSize > 0
  if (
    !valid(start) ||
    captionKind(start.text) !== 'figure' ||
    start.text.length < 35 ||
    /[.!?]$/u.test(start.text.trim()) ||
    page.invalidGraphicsBounds !== 0 ||
    ![page.width, page.height].every(Number.isFinite) ||
    page.width <= 0 ||
    page.height <= 0 ||
    !Array.isArray(page.lines) ||
    !Array.isArray(page.graphicsBounds)
  )
    return
  const following = runs
    .filter((r) => r.y > start.y && r.x < start.right && r.right > start.x)
    .sort((a, b) => a.y - b.y)
  const first = following[0]
  if (
    !valid(first) ||
    start.x - first.x < em * 0.5 ||
    start.x - first.x > em * 1.2 ||
    Math.abs(first.fontSize - em) > em * 0.01
  )
    return
  const leading = first.bottom - start.bottom,
    rows = [start]
  if (leading < em || leading > em * 1.3) return
  for (const row of following) {
    if (
      !valid(row) ||
      captionKind(row.text) ||
      /^Notes?\s*[:.]/iu.test(row.text) ||
      Math.abs(row.x - first.x) > em * 0.02 ||
      row.right > start.right + em * 0.05 ||
      Math.abs(row.bottom - rows.at(-1).bottom - leading) > em * 0.02 ||
      row.fontSize < em * 0.99 ||
      row.fontSize > em * 1.2 ||
      rows.length >= 12
    )
      break
    rows.push(row)
    if (/[.!?]$/u.test(row.text.trim()) && row.right - row.x < (start.right - first.x) * 0.8) break
  }
  const last = rows.at(-1),
    width = start.right - first.x,
    outliers = rows.flatMap((r, i) => (Math.abs(r.fontSize - em) > em * 0.01 ? [i] : [])),
    after = following[rows.length - 1]
  if (
    rows.length < 6 ||
    outliers.length !== 1 ||
    outliers[0] < 2 ||
    outliers[0] > rows.length - 3 ||
    rows[outliers[0]].fontSize < em * 1.1 ||
    !/[.!?]$/u.test(last.text.trim()) ||
    last.right - last.x >= width * 0.8 ||
    rows.slice(1, -1).some((r) => r.right - r.x < width * 0.9) ||
    !valid(after) ||
    after.fontSize < em * 1.2 ||
    after.y - last.bottom < em ||
    after.x < first.x ||
    after.x - first.x > em * 1.5
  )
    return
  const native = page.lines.filter(
    (l) =>
      l.text?.trim() &&
      l.x < start.right &&
      l.x + l.width > first.x &&
      l.y < last.bottom &&
      l.y + l.height > start.y
  )
  if (
    native.length !== rows.length ||
    native.some(
      (l) =>
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
        l.width <= 0 ||
        l.height <= 0 ||
        Math.abs(l.height - l.fontSize) > em * 0.01 ||
        rows.filter(
          (r) =>
            r.text === l.text &&
            Math.abs(r.x - l.x) < em * 0.01 &&
            Math.abs(r.y - l.y) < em * 0.01 &&
            Math.abs(r.right - l.x - l.width) < em * 0.01 &&
            Math.abs(r.bottom - l.y - l.height) < em * 0.01
        ).length !== 1
    )
  )
    return
  if (
    rules.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        (r[0] < start.right &&
          r[2] > first.x &&
          Math.min(r[1], r[3]) < last.bottom &&
          Math.max(r[1], r[3]) > start.y)
    )
  )
    return
  const images = []
  for (const g of page.graphicsBounds) {
    const raw = g?.normalizedRect,
      painted = g?.paintedNormalizedRect
    const good = (r) =>
      Array.isArray(r) &&
      r.length === 4 &&
      r.every(Number.isFinite) &&
      r.every((v) => v >= 0 && v <= 1) &&
      r[2] > r[0] &&
      r[3] > r[1]
    if (
      !good(raw) ||
      !['image', 'path'].includes(g.kind) ||
      (painted !== undefined &&
        (!good(painted) || painted.some((v, i) => (i < 2 ? v < raw[i] : v > raw[i]))))
    )
      return
    const r = (painted ?? raw).map((v, i) => v * (i % 2 ? page.height : page.width))
    if (r[0] < start.right && r[2] > first.x && r[1] < last.bottom && r[3] > start.y) return
    if (
      g.kind === 'image' &&
      r[3] <= start.y &&
      start.y - r[3] < em &&
      r[0] >= first.x - em &&
      r[2] <= start.right + em &&
      r[2] - r[0] >= width * 0.9 &&
      (r[2] - r[0]) * (r[3] - r[1]) > page.width * page.height * 0.04
    )
      images.push(r)
  }
  if (
    images.length !== 1 ||
    runs.some(
      (r) =>
        !rows.includes(r) &&
        valid(r) &&
        r.y >= images[0][3] &&
        r.bottom <= start.y &&
        r.x < start.right &&
        r.right > first.x
    )
  )
    return
  return rows.slice(1)
}

// A detached caption sheet need not carry the graphic on the same page. Prove
// the whole paragraph and its independent ending instead of extending a gap.
function findIndependentSpacedCaption(start, runs, page, rules) {
  const em = start.fontSize,
    width = start.right - start.x
  if (
    !/^(?:Figure|Fig\.?|Table)\s+[A-Z]?\d+(?:\.\d+)*[.:]\s/u.test(start.text) ||
    !Number.isFinite(em) ||
    em <= 0 ||
    width < page.width * 0.7 ||
    page.rotation !== 0 ||
    page.invalidGraphicsBounds !== 0
  )
    return
  const finite = (l) =>
      [l.x, l.y, l.right, l.bottom, l.fontSize].every(Number.isFinite) &&
      l.right > l.x &&
      l.bottom > l.y,
    near = runs
      .filter((l) => l.y > start.y && l.x < start.right && l.right > start.x)
      .sort((a, b) => a.y - b.y || a.x - b.x),
    rows = [start]
  let spacing
  for (const line of near) {
    const previous = rows.at(-1),
      gap = line.y - previous.bottom
    if (!finite(line) || captionKind(line.text) || /^Notes?\s*[:.]/i.test(line.text)) break
    if (rows.length >= 8 || Math.abs(line.x - start.x) > 0.1 || line.right > start.right + em * 0.1)
      break
    if (spacing === undefined) {
      if (line.y - start.y < em * 1.6 || line.y - start.y > em * 2.5) break
      spacing = gap
    } else if (Math.abs(gap - spacing) > em * 0.12) break
    if (Math.abs(line.fontSize - em) > 0.05) {
      const parts = page.lines.filter(
        (p) =>
          p.x < line.right && p.x + p.width > line.x && p.y < line.bottom && p.y + p.height > line.y
      )
      // A max-font line may include a raised small native script. A whole line
      // of larger prose, even with matching spacing, is not this evidence.
      const next = near[near.indexOf(line) + 1],
        raised = parts.some((p) => p.fontSize <= em * 0.8 && p.width <= em && p.height <= em * 0.8),
        isolatedBand =
          line.bottom - line.y > line.fontSize + em * 0.05 &&
          Math.abs(previous.fontSize - em) < 0.05 &&
          next &&
          Math.abs(next.fontSize - em) < 0.05 &&
          Math.abs(next.y - line.bottom - spacing) <= em * 0.12 &&
          line.right - line.x >= width * 0.95
      if (
        line.fontSize < em ||
        line.fontSize > em * 1.1 ||
        (!raised && !isolatedBand) ||
        parts.some(
          (p) =>
            p.x < line.x - 0.02 ||
            p.x + p.width > line.right + 0.02 ||
            p.y < line.y - 0.02 ||
            p.y + p.height > line.bottom + 0.02 ||
            p.fontSize > em * 1.1
        )
      )
        break
    }
    rows.push(line)
    if (line.right - line.x < width * 0.94) break
  }
  if (rows.length < 2) return
  const last = rows.at(-1),
    rect = [start.x, start.y, Math.max(...rows.map((l) => l.right)), last.bottom],
    following = near.find((l) => !rows.includes(l) && l.y >= last.bottom),
    closed = /[.!?]$/u.test(last.text.trim()),
    fontBoundary =
      following &&
      Math.abs(following.fontSize - em) > em * 0.06 &&
      following.y - last.bottom >= em * 1.5
  if (
    !closed ||
    last.right - last.x >= width * 0.94 ||
    rows.slice(0, -1).some((l) => l.right - l.x < width * 0.95)
  )
    return
  const graphics = []
  for (const g of page.graphicsBounds ?? []) {
    const n = g.paintedNormalizedRect ?? g.normalizedRect
    if (!Array.isArray(n) || n.length !== 4 || !n.every(Number.isFinite)) return
    const r = n.map((v, i) => v * (i % 2 ? page.height : page.width))
    if (r[0] < rect[2] && r[2] > rect[0] && r[1] < rect[3] && r[3] > rect[1]) return
    graphics.push({ kind: g.kind, rect: r })
  }
  if (
    rules.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        (r[0] < rect[2] && r[2] > rect[0] && r[1] < rect[3] && r[3] > rect[1])
    )
  )
    return
  const graphicBoundary = graphics.some(
      ({ kind, rect: r }) =>
        kind === 'image' &&
        r[1] >= last.bottom &&
        r[1] - last.bottom < em * 2 &&
        r[3] <= (following?.y ?? page.height) &&
        r[0] >= start.x - em &&
        r[2] <= start.right + em &&
        (r[2] - r[0]) * (r[3] - r[1]) > page.width * page.height * 0.02
    ),
    captionBoundary =
      following && captionKind(following.text) && following.y - last.bottom >= em * 2,
    pageEnd = !following && !runs.some((l) => l.y >= last.bottom && l.text.trim())
  if (!fontBoundary && !graphicBoundary && !captionBoundary && !pageEnd) return
  if (rows.length === 2) {
    // A single large gap has no repeated baseline evidence. Require the real
    // table ending above and a distinct following body font below the short tail.
    if (
      captionKind(start.text) !== 'table' ||
      !fontBoundary ||
      !rules.some((r) => {
        if (
          r[1] !== r[3] ||
          r[1] > start.y ||
          r[2] - r[0] < width * 0.5 ||
          r[0] < start.x - em ||
          r[2] > start.right + em
        )
          return false
        if (start.y - r[1] < em * 3) return true
        const tableRows = runs.filter(
          (l) =>
            l.y >= r[1] - em * 0.1 &&
            l.bottom < start.y &&
            l.x >= r[0] &&
            l.right <= r[2] &&
            l.fontSize < em &&
            /\d/.test(l.text)
        )
        return (
          start.y - r[1] < em * 5 &&
          tableRows.length >= 2 &&
          start.y - Math.max(...tableRows.map((l) => l.bottom)) < em * 1.5
        )
      })
    )
      return
  }
  const native = page.lines.filter(
    (p) =>
      p.text.trim() &&
      p.x < rect[2] &&
      p.x + p.width > rect[0] &&
      p.y < rect[3] &&
      p.y + p.height > rect[1]
  )
  if (
    native.some(
      (p) =>
        rows.filter(
          (l) =>
            p.x >= l.x - 0.02 &&
            p.x + p.width <= l.right + 0.02 &&
            p.y >= l.y - 0.02 &&
            p.y + p.height <= l.bottom + 0.02
        ).length !== 1
    )
  )
    return
  return rows.slice(1)
}

function findNativeCaptionParagraph(start, runs, page, rules) {
  if (start.text.length < 35) return
  const em = start.fontSize
  const center = (l) => (l.x + l.right) / 2
  const following = runs.filter((l) => l.y > start.y + 2 && l.y - start.y < em * 12)
  const first = following.find((l) => l.text.length > 15 && Math.abs(l.fontSize - em) < 0.7)
  const referenceContinuation =
    first &&
    /^(?:Fig\.?|Figure\.?)\s+[A-Z]?\d+(?:[.-]\d+)*[.:]\s/u.test(start.text) &&
    /^figure\.\s/u.test(first.text) &&
    Math.abs(first.x - start.x) < 2
  const ruledThreeHalves =
    first &&
    captionKind(start.text) === 'table' &&
    Math.abs(first.x - start.x) < 2 &&
    first.y - start.y >= em * 1.45 &&
    first.y - start.y <= em * 1.55 &&
    rules.some((opening) => {
      if (
        opening[1] !== opening[3] ||
        opening[1] <= first.bottom ||
        opening[1] - start.y > em * 18 ||
        opening[2] - opening[0] < (start.right - start.x) * 0.7 ||
        Math.abs((opening[0] + opening[2]) / 2 - center(start)) > em
      )
        return false
      return (
        rules.filter(
          (r) =>
            r[1] === r[3] &&
            r[1] >= opening[1] &&
            Math.abs(r[0] - opening[0]) < 0.1 &&
            Math.abs(r[2] - opening[2]) < 0.1
        ).length >= 3
      )
    })
  if (
    !first ||
    first.y - start.y < em * (referenceContinuation ? 1.15 : ruledThreeHalves ? 1.45 : 1.6) ||
    first.y - start.y > em * 2.1
  )
    return
  const centered =
    captionKind(start.text) === 'table' && Math.abs(center(first) - center(start)) < em
  const hanging =
    captionKind(start.text) === 'figure' &&
    first.x - start.x >= em * 2 &&
    first.x - start.x <= em * 8 &&
    Math.abs(first.right - start.right) < em
  const flush = Math.abs(first.x - start.x) < 2
  if (!centered && !hanging && !flush) return
  const tail = []
  const leading = first.y - start.y
  const closedLine = (l) =>
    /[.!?]$/.test(l.text.trim()) ||
    page.lines.some(
      (p) =>
        /[.!?]$/.test(p.text.trim()) &&
        Math.abs(p.y - l.y) < em * 0.2 &&
        p.x >= l.x &&
        p.x + p.width <= l.right + 0.1 &&
        p.fontSize >= em * 0.95
    )
  for (const line of following) {
    if (line.text.length < 5 && !captionKind(line.text)) continue
    const previous = tail.at(-1) ?? start
    if (
      (captionKind(line.text) && !(referenceContinuation && line === first)) ||
      /^Notes?\s*[:.]/i.test(line.text) ||
      Math.abs(line.fontSize - em) >= 0.7 ||
      Math.abs(line.y - previous.y - leading) > em * 0.2 ||
      line.x < start.x - 2 ||
      line.right > start.right + em ||
      !(centered && !ruledThreeHalves
        ? Math.abs(center(line) - center(start)) < em
        : Math.abs(line.x - first.x) < 2)
    )
      break
    tail.push(line)
  }
  if (
    !tail.length ||
    (hanging && tail.length < 2) ||
    (ruledThreeHalves && tail.length < 3) ||
    !closedLine(tail.at(-1))
  )
    return
  const bottom = tail.at(-1).bottom
  const fullBorder = (r) =>
    r[1] === r[3] &&
    r[2] - r[0] >= (start.right - start.x) * 0.7 &&
    Math.abs((r[0] + r[2]) / 2 - center(start)) < em
  const bordered =
    rules.some(
      (r) =>
        fullBorder(r) &&
        ((r[1] <= start.y + em * 0.15 && start.y - r[1] < em * 2) ||
          (r[1] >= bottom && r[1] - bottom < em * 3))
    ) ||
    (captionKind(start.text) === 'table' &&
      (page.graphicsBounds ?? []).some((g) => {
        const [left, top, right, end] = g.normalizedRect.map(
          (v, n) => v * (n % 2 ? page.height : page.width)
        )
        return (
          g.kind === 'path' &&
          end - top <= em &&
          fullBorder([left, top, right, top]) &&
          top >= bottom &&
          top - bottom < em * (flush && tail.length >= 2 ? 9 : 3)
        )
      }))
  const graphic =
    captionKind(start.text) === 'figure' &&
    (page.graphicsBounds ?? []).some((g) => {
      const [left, top, right, end] = g.normalizedRect.map(
        (v, n) => v * (n % 2 ? page.height : page.width)
      )
      return (
        (g.kind === 'image' || g.kind === 'path') &&
        (right - left) * (end - top) > page.width * page.height * 0.04 &&
        end <= start.y + 2 &&
        start.y - end < em * 3 &&
        left >= start.x - em &&
        right <= start.right + em
      )
    })
  const fragmentedGraphic =
    tail.length >= 2 && flush && provesFragmentedCaptionGraphic(start, runs, page, tail.at(-1))
  if (!bordered && !graphic && !fragmentedGraphic) return
  // Detached accent runs are still source content. Retain their original
  // text alongside the proven line rather than dropping a font fragment.
  const fragments = following.filter(
    (l) =>
      l.text.length < 5 &&
      l.y < bottom &&
      l.y >= first.y - em * 0.4 &&
      l.x >= start.x &&
      l.right <= start.right &&
      tail.some((t) => l.y >= t.y - em * 0.4 && l.bottom <= t.bottom + em * 0.3)
  )
  return [...tail, ...fragments].sort((a, b) => a.y - b.y || a.x - b.x)
}

// Vector panels may consist entirely of small painted paths. The complete
// uniformly spaced, closed paragraph is already proven by the caller. Require
// a numbered native title, a substantial graphics group in the same column, and
// no intervening prose; separate captions and standalone Notes stay outside.
function provesFragmentedCaptionGraphic(
  start,
  runs,
  page,
  last,
  maxLastWidth = 0.95,
  minArea = 0.04
) {
  if (
    !/^(?:Fig\.?|Figure\.?)\s+[A-Z]?\d+(?:[.-]\d+)*[.:]?[—–]?\s/iu.test(start.text) ||
    last.right - last.x >= (start.right - start.x) * maxLastWidth
  )
    return false
  const em = start.fontSize
  const prior = runs
    .filter(
      (l) => l.bottom < start.y && l.x < start.right && l.right > start.x && captionKind(l.text)
    )
    .sort((a, b) => b.bottom - a.bottom)[0]
  const limit = Math.max(start.y - page.height * 0.65, prior?.bottom ?? 0)
  const bounds = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'path' || g.kind === 'image')
    .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)))
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[2] > r[0] &&
        r[3] > r[1] &&
        r[0] >= start.x - em &&
        r[2] <= start.right + em &&
        r[1] >= limit &&
        r[3] <= start.y + em * 0.1
    )
  const unique = [...new Map(bounds.map((r) => [r.join(','), r])).values()]
  if (unique.length < 3) return false
  const left = Math.min(...unique.map((r) => r[0]))
  const top = Math.min(...unique.map((r) => r[1]))
  const right = Math.max(...unique.map((r) => r[2]))
  const bottom = Math.max(...unique.map((r) => r[3]))
  if (
    (right - left) * (bottom - top) < page.width * page.height * minArea ||
    right - left < (start.right - start.x) * 0.5 ||
    start.y - bottom > em * 6 ||
    runs.some(
      (l) =>
        l !== start &&
        l.text.length >= 60 &&
        l.right - l.x >= (start.right - start.x) * 0.6 &&
        l.fontSize >= em * 0.8 &&
        l.y >= bottom - em * 0.1 &&
        l.bottom <= start.y &&
        l.x < start.right &&
        l.right > start.x
    )
  )
    return false
  return true
}

// Caller proves caption ownership before supplying this source-only block.
// Each fragment remains in exactly one vertically connected physical row;
// no source text or symbol is substituted, and separated rows stay separated.
export function groupNativeCaptionFragments(lines, fontSize) {
  if (
    !(fontSize > 0) ||
    lines.some(
      (l) =>
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
        l.height <= 0 ||
        l.fontSize < fontSize * 0.5 ||
        l.fontSize > fontSize * 1.45
    )
  )
    return
  const rows = []
  for (const part of [...lines].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.at(-1)
    if (row && part.y < row.bottom && part.y + part.height > row.y) {
      row.parts.push(part)
      row.bottom = Math.max(row.bottom, part.y + part.height)
    } else rows.push({ y: part.y, bottom: part.y + part.height, parts: [part] })
  }
  return rows.map((row) => {
    const parts = [...row.parts].sort((a, b) => a.x - b.x || a.y - b.y)
    return {
      ...row,
      parts,
      text: parts.map((p) => p.text).join(' '),
      x: parts[0].x,
      right: Math.max(...parts.map((p) => p.x + p.width)),
      fontSize
    }
  })
}

// In a raster legend, native formula text can use taller font boxes than the
// neighboring prose. Join only vertically connected native fragments under
// one graphic, keeping the aligned paragraph edge and every source fragment.
function findNativeMixedLegend(start, page) {
  if (captionKind(start.text) !== 'figure' || start.text.length < 35) return
  const em = start.fontSize
  const pageEnd = start.y > page.height * 0.8
  const graphics = [
    ...new Map(
      (page.graphicsBounds ?? [])
        .filter(
          (g) =>
            (g.kind === 'image' || (pageEnd && g.kind === 'path')) &&
            g.normalizedRect[2] - g.normalizedRect[0] > 0.5 &&
            g.normalizedRect[3] * page.height <= start.y &&
            start.y - g.normalizedRect[3] * page.height < em * 3
        )
        .map((g) => [JSON.stringify(g.normalizedRect), g])
    ).values()
  ]
  if (graphics.length !== 1) return
  const aligned = page.lines.filter(
    (l) =>
      l.y > start.y + em * 0.8 &&
      l.y < start.y + em * 8 &&
      Math.abs(l.x - start.x) < em * 0.1 &&
      Math.abs(l.fontSize - em) < em * 0.01 &&
      l.text.length >= 40
  )
  const repeatedEdge = aligned.find((l) =>
    aligned.some(
      (other) => other !== l && Math.abs(other.x + other.width - l.x - l.width) < em * 0.1
    )
  )
  const edge = pageEnd
    ? Math.max(start.right, page.width - start.x)
    : Math.max(start.right, repeatedEdge ? repeatedEdge.x + repeatedEdge.width : start.right)
  const source = page.lines
    .filter(
      (l) =>
        l.y >= start.y - 1 &&
        l.y < start.y + em * 10 &&
        l.x >= start.x - 1 &&
        l.x + l.width <= edge + em &&
        l.fontSize <= em * 1.45 &&
        l.fontSize >= em * 0.5
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const connected = groupNativeCaptionFragments(source, em)
  if (!connected) return
  const rows = connected.flatMap((row) => splitNativeCaptionBaselines(row, start.x, em))
  const selected = []
  for (const row of rows) {
    const sorted = row.parts.sort((a, b) => a.x - b.x || a.y - b.y)
    if (
      Math.abs(sorted[0].x - start.x) > 2 ||
      (selected.length &&
        (row.y - selected.at(-1).bottom > em * 1.7 || row.y <= selected.at(-1).bottom))
    )
      break
    const text = sorted.map((l) => l.text).join(' ')
    if (selected.length && captionKind(text)) break
    selected.push({
      ...row,
      text,
      x: sorted[0].x,
      right: Math.max(...sorted.map((l) => l.x + l.width)),
      fontSize: em
    })
    const terminal = sorted.find(
      (l) =>
        /[.!?]$/.test(l.text.trim()) &&
        l.x + l.width >= Math.max(...sorted.map((p) => p.x + p.width)) - em * 0.2
    )
    if (selected.length >= 3 && terminal && selected.at(-1).right < edge - em * 0.4) break
  }
  const unfinishedPageEnd =
    pageEnd &&
    selected.length >= 2 &&
    page.lines.every(
      (l) =>
        l.y <= selected.at(-1).bottom ||
        (/^\d+$/.test(l.text.trim()) &&
          Math.abs(l.x + l.width / 2 - page.width / 2) < l.fontSize &&
          l.y > page.height * 0.85)
    )
  if (
    !unfinishedPageEnd &&
    (selected.length < 3 ||
      !selected.some((r) =>
        r.parts.some((l) => l.fontSize > em * 1.2 || (r.parts.length > 1 && l.height > em * 1.1))
      ))
  )
    return
  const last = selected.at(-1)
  if (
    !unfinishedPageEnd &&
    !last.parts.some((l) => /[.!?]$/.test(l.text.trim()) && l.x + l.width >= last.right - em * 0.2)
  )
    return
  return selected.slice(1)
}

// Raised operators may connect the ink boxes of two separate prose rows.
// Repeated left-edge baselines and unique literal edge attachment split that
// connection without interpreting the formula or dropping any source part.
function splitNativeCaptionBaselines(row, left, em) {
  const heads = row.parts
    .filter(
      (p) =>
        Math.abs(p.x - left) < em * 0.1 &&
        Math.abs(p.fontSize - em) < em * 0.01 &&
        p.text.length >= 10
    )
    .sort((a, b) => a.y - b.y)
  if (
    heads.length < 2 ||
    heads.some((p, i) => i && (p.y - heads[i - 1].y < em * 0.9 || p.y - heads[i - 1].y > em * 1.6))
  )
    return [row]
  const groups = heads.map((h) => ({ ...row, y: h.y, parts: [] }))
  for (const part of row.parts) {
    let owners = heads.flatMap((h, i) => (Math.abs(part.y - h.y) < em * 0.15 ? [i] : []))
    if (!owners.length && part.text.trim().length <= 2 && Math.abs(part.fontSize - em) < em * 0.01)
      owners = heads.flatMap((h, i) =>
        h.y > part.y + em * 0.2 &&
        h.y - part.y < em &&
        row.parts.some(
          (base) =>
            Math.abs(base.y - h.y) < em * 0.1 &&
            Math.abs(base.fontSize - em) < em * 0.01 &&
            Math.min(
              Math.abs(part.x - base.x - base.width),
              Math.abs(base.x - part.x - part.width)
            ) <
              em * 0.2
        )
          ? [i]
          : []
      )
    if (owners.length !== 1) return [row]
    groups[owners[0]].parts.push(part)
  }
  return groups.map((g) => ({
    ...g,
    parts: g.parts.sort((a, b) => a.x - b.x || a.y - b.y),
    text: g.parts.map((p) => p.text).join(' '),
    bottom: Math.max(...g.parts.map((p) => p.y + p.height)),
    right: Math.max(...g.parts.map((p) => p.x + p.width))
  }))
}

// Mutate the canonical caption only after a unique same-source match. Table
// matching retains the established exact-title/accent proof; figure formulas
// may change the title text but cannot change its formal ordinal or position.
// An inward caption contraction needs the complete original header fonts and
// their independent opening/divider/footer strokes, rather than a looser x match.
function provesRuledHeaderExclusion(candidate, caption, page, rules, fonts) {
  const compact = (s) => s.replace(/\s/gu, '')
  if (
    caption.lines.length !== 1 ||
    candidate.lines.length !== 2 ||
    caption.lines[0] !== candidate.lines[0] ||
    caption.rect[0] <= candidate.rect[0] ||
    Math.abs(caption.rect[2] - candidate.rect[2]) > 0.01 ||
    caption.rect[3] >= candidate.rect[3]
  )
    return false
  const valid = (i) =>
    i.horizontal &&
    i.rect?.length === 4 &&
    i.rect.every(Number.isFinite) &&
    i.height > 0 &&
    i.rect[0] < i.rect[2] &&
    Math.abs(i.rect[3] - i.baseline) < 0.02 &&
    Math.abs(i.rect[3] - i.rect[1] - i.height) < 0.02 &&
    i.sourceItem?.pageNumber === page.pageNumber &&
    i.sourceItem.text === i.text &&
    Number.isSafeInteger(i.sourceItem.index)
  const title = fonts.filter(
    (i) =>
      i.rect?.[0] >= caption.rect[0] - 0.01 &&
      i.rect?.[2] <= caption.rect[2] + 0.01 &&
      i.rect?.[1] >= caption.rect[1] - 0.01 &&
      i.rect?.[3] <= caption.rect[3] + 0.01
  )
  if (
    !title.length ||
    title.some((i) => !valid(i)) ||
    compact(title.map((i) => i.text).join('')) !== compact(caption.lines[0])
  )
    return false
  const h = Math.max(...title.map((i) => i.height))
  if (caption.rect[0] - candidate.rect[0] > h * 0.2) return false
  const edges = rules
    .filter(
      (r) =>
        r?.length === 4 &&
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        r[1] > caption.rect[3] &&
        r[1] < caption.rect[3] + h * 20 &&
        r[0] <= caption.rect[0] &&
        caption.rect[0] - r[0] < h * 2 &&
        r[2] >= caption.rect[2] &&
        r[2] - caption.rect[2] < h * 2
    )
    .sort((a, b) => a[1] - b[1])
  if (
    edges.length !== 3 ||
    edges[0][1] - caption.rect[3] > h * 2 ||
    edges.some((r) => Math.abs(r[0] - edges[0][0]) > 0.01 || Math.abs(r[2] - edges[0][2]) > 0.01)
  )
    return false
  const [opening, divider, closing] = edges
  const header = fonts.filter(
    (i) =>
      i.rect?.[0] < opening[2] &&
      i.rect?.[2] > opening[0] &&
      i.rect?.[1] < divider[1] &&
      i.rect?.[3] > opening[1]
  )
  if (
    header.length < 2 ||
    header.some(
      (i) =>
        !valid(i) ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] <= opening[1] ||
        i.rect[3] >= divider[1] ||
        i.rect[3] > candidate.rect[3] + 0.01
    ) ||
    new Set(header.map((i) => i.sourceItem.index)).size !== header.length ||
    compact(header.map((i) => i.text).join('')) !== compact(candidate.lines[1])
  )
    return false
  return (
    closing[1] > divider[1] &&
    header.every(
      (i) =>
        i.rect[1] >= candidate.rect[1] &&
        i.rect[0] >= candidate.rect[0] - 0.01 &&
        i.rect[2] <= candidate.rect[2] + 0.01
    )
  )
}

// A centered Roman label can precede smallcaps prose with larger literal
// variables. Plain grouped rows cannot prove those source carriers: recover
// only at the existing complete-font, native-rule entry, without relaxing the
// all-caps scan or inferring font styles or variable names.
function recoverNativeRomanVariableCaption(candidate, page, rules, fonts) {
  if (
    candidate.lines.length !== 2 ||
    candidate.rect?.length !== 4 ||
    !candidate.rect.every(Number.isFinite) ||
    !/^TABLE\s+[IVXLCDM]+\.?$/u.test(candidate.lines[0]) ||
    page.invalidGraphicsBounds !== 0 ||
    !fonts.length ||
    fonts.some(
      (i) =>
        i.rect?.length !== 4 ||
        !i.rect.every(Number.isFinite) ||
        ![i.baseline, i.height].every(Number.isFinite) ||
        i.height <= 0 ||
        i.rect[0] >= i.rect[2] ||
        i.rect[1] >= i.rect[3] ||
        Math.abs(i.rect[3] - i.rect[1] - i.height) > 0.02 ||
        Math.abs(i.rect[3] - i.baseline) > 0.02 ||
        i.sourceItem?.pageNumber !== page.pageNumber ||
        i.sourceItem.text !== i.text ||
        !Number.isSafeInteger(i.sourceItem.index) ||
        i.sourceItem.index < 0
    ) ||
    new Set(fonts.map((i) => i.sourceItem.index)).size !== fonts.length ||
    rules.some((r) => r?.length !== 4 || !r.every(Number.isFinite))
  )
    return
  const runs = groupPageLines(page),
    labels = runs.filter(
      (r) => r.text === candidate.lines[0] && Math.abs(r.y - candidate.rect[1]) < 0.01
    )
  if (labels.length !== 1) return
  const start = labels[0],
    em = start.fontSize,
    center = (start.x + start.right) / 2,
    validRule = (r) => r?.length === 4 && r.every(Number.isFinite),
    edges = rules
      .filter(
        (r) =>
          validRule(r) &&
          r[1] === r[3] &&
          r[1] > start.bottom &&
          r[1] - start.bottom < em * 20 &&
          r[2] - r[0] > page.width * 0.4 &&
          Math.abs((r[0] + r[2]) / 2 - center) < em * 0.05
      )
      .sort((a, b) => a[1] - b[1])
  if (!(em > 0) || edges.length < 3) return
  const opening = edges[0],
    rows = runs
      .filter((r) => r.y >= start.y - 0.01 && r.bottom < opening[1])
      .sort((a, b) => a.y - b.y),
    first = rows[1],
    last = rows.at(-1)
  if (
    rows[0] !== start ||
    rows.length < 4 ||
    rows.length > 8 ||
    candidate.lines.some((s, i) => rows[i]?.text !== s) ||
    /\p{Ll}/u.test(first.text) ||
    first.right - first.x < page.width * 0.6 ||
    last.right - last.x > (first.right - first.x) * 0.3 ||
    !/\p{Ll}/u.test(last.text) ||
    rows.some(
      (r, n) =>
        Math.abs(r.fontSize - em) > em * 0.01 ||
        Math.abs((r.x + r.right) / 2 - center) > em * 0.05 ||
        (n && (r.y - rows[n - 1].y < em * 0.95 || r.y - rows[n - 1].y > em * 1.3)) ||
        (n > 1 && Math.abs(r.y - rows[n - 1].y - (first.y - start.y)) > em * 0.015) ||
        (n > 1 &&
          n < rows.length - 1 &&
          (Math.abs(r.x - first.x) > em * 0.05 || Math.abs(r.right - first.right) > em * 0.05))
    ) ||
    opening[1] - last.bottom < em * 0.8 ||
    opening[1] - last.bottom > em * 2 ||
    opening[0] < first.x ||
    opening[2] > first.right ||
    opening[2] - opening[0] < (first.right - first.x) * 0.5
  )
    return
  const prefixRect = [
    Math.min(start.x, first.x),
    start.y,
    Math.max(start.right, first.right),
    first.bottom
  ]
  if (candidate.rect.some((v, n) => Math.abs(v - prefixRect[n]) > 0.01)) return
  if (
    runs.some(
      (r) =>
        !rows.includes(r) &&
        r.right > first.x &&
        r.x < first.right &&
        r.bottom > start.y - em &&
        r.y < opening[1] - em * 0.1
    )
  )
    return
  const frame = edges.filter(
    (r) => Math.abs(r[0] - opening[0]) < 0.01 && Math.abs(r[2] - opening[2]) < 0.01
  )
  if (
    frame.length !== 3 ||
    new Set(frame.map((r) => r.join(','))).size !== 3 ||
    frame[1][1] - opening[1] < em ||
    frame[1][1] - opening[1] > em * 2 ||
    frame[2][1] - frame[1][1] < em * 2 ||
    frame[2][1] - opening[1] > em * 12
  )
    return
  const vertical = rules.filter(
    (r) =>
      validRule(r) &&
      r[0] === r[2] &&
      r[0] >= opening[0] - em * 0.05 &&
      r[0] <= opening[2] + em * 0.05 &&
      r[1] >= opening[1] - em * 0.05 &&
      r[3] <= frame[2][1] + em * 0.05
  )
  const columns = [...new Set(vertical.map((r) => r[0]))].sort((a, b) => a - b)
  if (
    columns.length < 4 ||
    Math.abs(columns[0] - opening[0]) > em * 0.05 ||
    Math.abs(columns.at(-1) - opening[2]) > em * 0.05 ||
    columns.some((x) => {
      const pieces = vertical.filter((r) => r[0] === x).sort((a, b) => a[1] - b[1])
      return (
        pieces[0][1] - opening[1] > em * 0.05 ||
        frame[2][1] - pieces.at(-1)[3] > em * 0.05 ||
        pieces.some((r, n) => r[3] <= r[1] || (n && r[1] - pieces[n - 1][3] > em * 0.06))
      )
    })
  )
    return
  const overlap = (r) => r?.length === 4 && r[0] < first.right && r[2] > first.x,
    relevant = fonts.filter(
      (i) => overlap(i.rect) && i.rect[3] > start.y - em && i.rect[1] < opening[1]
    ),
    valid = (i) =>
      i.horizontal &&
      i.rect.every(Number.isFinite) &&
      i.height > 0 &&
      i.rect[2] > i.rect[0] &&
      Math.abs(i.rect[3] - i.baseline) < em * 0.01 &&
      Math.abs(i.rect[3] - i.rect[1] - i.height) < em * 0.01 &&
      Number.isFinite(i.fontDescent) &&
      i.sourceItem?.pageNumber === page.pageNumber &&
      i.sourceItem.text === i.text &&
      Number.isSafeInteger(i.sourceItem.index) &&
      i.sourceItem.index >= 0,
    compact = (s) => s.replace(/\s/gu, '')
  if (
    relevant.some((i) => !valid(i)) ||
    new Set(relevant.map((i) => i.sourceItem.index)).size !== relevant.length
  )
    return
  const labelFonts = relevant.filter((i) => Math.abs(i.baseline - start.bottom) < em * 0.01)
  if (labelFonts.length !== 1 || labelFonts[0].text !== start.text) return
  const descent = labelFonts[0].fontDescent,
    owned = new Set()
  for (const [n, row] of rows.entries()) {
    const carriers = relevant
      .filter((i) => Math.abs(i.baseline - row.bottom) < em * 0.01)
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      !carriers.length ||
      compact(carriers.map((i) => i.text).join('')) !== compact(row.text) ||
      Math.abs(carriers[0].rect[0] - row.x) > em * 0.01 ||
      Math.abs(carriers.at(-1).rect[2] - row.right) > em * 0.01 ||
      carriers.some(
        (i, k) =>
          i.rect[0] < row.x - em * 0.01 ||
          i.rect[2] > row.right + em * 0.01 ||
          (k &&
            (i.sourceItem.index <= carriers[k - 1].sourceItem.index ||
              i.rect[0] - carriers[k - 1].rect[2] < -em * 0.01 ||
              i.rect[0] - carriers[k - 1].rect[2] > em * 0.6))
      )
    )
      return
    const small = carriers.filter((i) => Math.abs(i.height / em - 0.8) < 0.02)
    if (
      n &&
      (!small.length ||
        small.some((i) => /\p{Ll}/u.test(i.text) || Math.abs(i.fontDescent - descent) > 0.001))
    )
      return
    if (
      carriers.some((i) => {
        if (small.includes(i)) return false
        if (Math.abs(i.height - em) > em * 0.01) return true
        return (
          /\p{Ll}/u.test(i.text) &&
          (!/^\p{Ll}{1,3}$/u.test(i.text) ||
            Math.abs(i.fontDescent - descent) < 0.005 ||
            Math.abs(i.fontDescent - descent) > 0.1)
        )
      })
    )
      return
    for (const carrier of carriers) owned.add(carrier)
  }
  const headerRows = runs.filter(
      (r) =>
        r.y >= opening[1] - em * 0.1 &&
        r.bottom > opening[1] &&
        r.bottom < frame[1][1] &&
        r.x >= opening[0] &&
        r.right <= opening[2]
    ),
    header = headerRows[0]
  if (headerRows.length !== 1) return
  const headerFonts = fonts
    .filter((i) => Math.abs(i.baseline - header.bottom) < em * 0.01 && overlap(i.rect))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    !headerFonts.length ||
    headerFonts.some(
      (i) =>
        !valid(i) ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] < opening[1] - em * 0.1
    ) ||
    compact(headerFonts.map((i) => i.text).join('')) !== compact(header.text) ||
    Math.abs(headerFonts[0].rect[0] - header.x) > em * 0.01 ||
    Math.abs(headerFonts.at(-1).rect[2] - header.right) > em * 0.01 ||
    new Set(headerFonts.map((i) => i.sourceItem.index)).size !== headerFonts.length ||
    relevant.some((i) => !owned.has(i) && !headerFonts.includes(i))
  )
    return
  if (
    rules.some(
      (r) =>
        validRule(r) &&
        Math.max(r[0], r[2]) > first.x &&
        Math.min(r[0], r[2]) < first.right &&
        Math.max(r[1], r[3]) > start.y - em &&
        Math.min(r[1], r[3]) < opening[1] - em * 0.01
    )
  )
    return
  if (
    (page.graphicsBounds ?? []).some((g) => {
      if (
        g.normalizedRect?.length !== 4 ||
        !g.normalizedRect.every(Number.isFinite) ||
        g.normalizedRect[0] >= g.normalizedRect[2] ||
        g.normalizedRect[1] >= g.normalizedRect[3] ||
        !['path', 'image'].includes(g.kind)
      )
        return true
      const r = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)),
        contained =
          r &&
          [...frame, ...vertical].filter(
            (edge) => edge[0] >= r[0] && edge[2] <= r[2] && edge[1] >= r[1] && edge[3] <= r[3]
          )
      if (!r?.every(Number.isFinite)) return true
      if (!overlap(r) || r[3] <= start.y - em) return false
      if (r[1] < last.bottom + em * 0.8 || (g.kind !== 'path' && r[1] < opening[1] + em * 2))
        return true
      if (r[1] >= opening[1]) return false
      return (
        r[1] < opening[1] - page.height / 256 ||
        r[0] < opening[0] - page.width / 128 ||
        r[2] > opening[2] + page.width / 128 ||
        !contained.length ||
        r[0] < Math.min(...contained.map((e) => e[0])) - page.width / 128 ||
        r[2] > Math.max(...contained.map((e) => e[2])) + page.width / 128 ||
        r[3] > Math.max(...contained.map((e) => e[3])) + page.height / 128
      )
    })
  )
    return
  return { lines: rows.map((r) => r.text), rect: [first.x, start.y, first.right, last.bottom] }
}

// A larger numbered label can share a baseline with smaller explanatory type.
// Its complete native carriers, rather than the merged row's maximum em, prove
// a separately led paragraph. Leave ordinary continuation thresholds intact.
function recoverNativeLedMixedCaption(candidate, page, rules, fonts) {
  const prefix = /^(?:Figure|Table)\s+[A-Z]?\d+:/.exec(candidate.lines[0])?.[0]
  if (
    !prefix ||
    ![page.width, page.height].every((value) => Number.isFinite(value) && value > 0) ||
    candidate.lines.length !== 1 ||
    page.invalidGraphicsBounds !== 0 ||
    candidate.rect?.length !== 4 ||
    !candidate.rect.every(Number.isFinite) ||
    !fonts.length ||
    fonts.some(
      (i) =>
        i.rect?.length !== 4 ||
        !i.rect.every(Number.isFinite) ||
        ![i.height, i.baseline].every(Number.isFinite) ||
        i.height <= 0 ||
        typeof i.horizontal !== 'boolean' ||
        i.rect[0] >= i.rect[2] ||
        i.rect[1] >= i.rect[3] ||
        (i.horizontal &&
          (Math.abs(i.rect[3] - i.baseline) > 0.02 ||
            Math.abs(i.rect[3] - i.rect[1] - i.height) > 0.02)) ||
        i.sourceItem?.pageNumber !== page.pageNumber ||
        i.sourceItem.text !== i.text ||
        !Number.isSafeInteger(i.sourceItem.index) ||
        i.sourceItem.index < 0
    ) ||
    new Set(fonts.map((i) => i.sourceItem.index)).size !== fonts.length ||
    rules.some((r) => r?.length !== 4 || !r.every(Number.isFinite)) ||
    (page.graphicsBounds ?? []).some(
      (g) =>
        g.normalizedRect?.length !== 4 ||
        !g.normalizedRect.every(Number.isFinite) ||
        !['image', 'path'].includes(g.kind) ||
        g.normalizedRect.some((v) => v < 0 || v > 1) ||
        g.normalizedRect[0] > g.normalizedRect[2] ||
        g.normalizedRect[1] > g.normalizedRect[3]
    )
  )
    return
  const runs = groupPageLines(page),
    heads = runs.filter(
      (r) =>
        r.text === candidate.lines[0] &&
        [r.x, r.y, r.right, r.bottom].every((v, n) => Math.abs(v - candidate.rect[n]) < 0.02)
    )
  if (heads.length !== 1) return
  const start = heads[0],
    em = start.fontSize,
    width = start.right - start.x
  const labels = fonts.filter(
    (i) =>
      i.text.trim() === prefix &&
      Math.abs(i.rect[0] - start.x) < em * 0.05 &&
      Math.abs(i.height - em) < em * 0.01 &&
      Math.abs(i.rect[1] - start.y) < em * 0.01
  )
  if (!(em > 0) || width < page.width * 0.5 || labels.length !== 1) return
  const label = labels[0],
    smaller = fonts.filter(
      (i) =>
        i !== label &&
        i.horizontal &&
        Math.abs(i.baseline - label.baseline) < em * 0.01 &&
        i.rect[0] >= label.rect[2] &&
        i.rect[2] <= start.right + em * 0.2 &&
        i.height >= em * 0.9 &&
        i.height <= em * 0.93
    )
  if (!smaller.length) return
  const bodyEm = smaller[0].height
  if (smaller.some((i) => Math.abs(i.height - bodyEm) > em * 0.01)) return
  const tail = []
  for (const row of runs
    .filter((r) => r.y > start.y + 2 && r.x < start.right && r.right > start.x)
    .sort((a, b) => a.y - b.y || a.x - b.x)) {
    const prior = tail.at(-1) ?? start
    if (
      captionKind(row.text) ||
      Math.abs(row.x - start.x) > em * 0.15 ||
      row.right > start.right + em * 0.3 ||
      Math.abs(row.fontSize - bodyEm) > em * 0.01 ||
      row.y - prior.y < bodyEm * 1.5 ||
      row.y - prior.y > bodyEm * 1.82 ||
      tail.length >= 5
    )
      break
    tail.push(row)
    if (/[.!?]$/.test(row.text.trim())) break
  }
  const last = tail.at(-1)
  if (!last || !/[.!?]$/.test(last.text.trim())) return
  const band = [start, ...tail],
    lower = last.bottom + bodyEm * 0.7
  if (
    (page.graphicsBounds ?? []).some((g) => {
      const r = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
      return r[0] < start.right && r[2] > start.x && r[1] < lower && r[3] > start.y
    })
  )
    return
  if (
    runs.some(
      (r) =>
        !band.includes(r) &&
        r.right > start.x &&
        r.x < start.right &&
        r.bottom > start.y &&
        r.y < lower
    )
  )
    return
  const relevant = fonts.filter(
    (i) =>
      i.rect[2] > start.x - em * 0.15 &&
      i.rect[0] < start.right + em * 0.3 &&
      i.rect[3] > start.y &&
      i.rect[1] < lower
  )
  const literal = (text) =>
    text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (d) => String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(d))).replace(/\s/gu, '')
  const owned = new Set()
  for (const [n, row] of band.entries()) {
    const anchors = relevant.filter(
      (i) =>
        i.horizontal &&
        Math.abs(i.height - (n ? bodyEm : em)) < em * 0.01 &&
        i.rect[0] >= row.x - em * 0.15 &&
        i.rect[2] <= row.right + em * 0.3 &&
        Math.abs(i.rect[1] - row.y) < em * 0.2
    )
    if (
      !anchors.length ||
      anchors.some((i) => Math.abs(i.baseline - anchors[0].baseline) > em * 0.01)
    )
      return
    const base = anchors[0].baseline,
      carriers = relevant.filter(
        (i) =>
          i.horizontal &&
          i.rect[0] >= row.x - em * 0.15 &&
          i.rect[2] <= row.right + em * 0.3 &&
          Math.abs(i.baseline - base) <= bodyEm * 0.55 &&
          i.height <= (n ? bodyEm : em) + em * 0.01
      )
    if (
      !carriers.length ||
      carriers.some((i) => owned.has(i)) ||
      literal(
        carriers
          .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
          .map((i) => i.text)
          .join('')
      ) !== literal(row.text)
    )
      return
    for (const i of carriers) owned.add(i)
  }
  if (relevant.some((i) => !owned.has(i))) return
  if (captionKind(start.text) === 'figure') {
    if (
      !provesSingleCaptionRaster(start, runs, page) &&
      !provesFragmentedCaptionGraphic(start, runs, page, last, 1.02, 0.025)
    )
      return
  } else if (
    !rules.some(
      (r) =>
        r[1] === r[3] &&
        r[1] > last.bottom &&
        r[1] - last.bottom <= bodyEm * 1.2 &&
        r[0] >= start.x &&
        r[2] <= start.right &&
        r[2] - r[0] > width * 0.7
    )
  )
    return
  return {
    lines: band.map((r) => r.text),
    rect: [
      Math.min(...band.map((r) => r.x)),
      start.y,
      Math.max(...band.map((r) => r.right)),
      last.bottom
    ]
  }
}

// Restore an already accepted caption only from a complete native row block.
// Centered publisher lines have one center and one primary baseline cadence;
// neither alignment nor wording replaces the independent graphic/table frame.
function recoverNativeClosedCaptionBlock(candidate, page, rules, fonts) {
  const centered =
    /^(?:FIG\.\s+\d+|TABLE\s+[IVXLCDM]+):\s+\S/u.test(candidate.lines[0]) &&
    candidate.lines.length === 1
  const reference =
    captionKind(candidate.lines[0]) === 'figure' &&
    candidate.lines.length >= 2 &&
    /\bprovided\s+in$/u.test(candidate.lines.at(-1).trim())
  if (
    (!centered && !reference) ||
    ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
    !Number.isSafeInteger(page.pageNumber) ||
    page.pageNumber < 1 ||
    page.invalidGraphicsBounds !== 0 ||
    candidate.rect?.length !== 4 ||
    !candidate.rect.every(Number.isFinite) ||
    candidate.rect[0] >= candidate.rect[2] ||
    candidate.rect[1] >= candidate.rect[3] ||
    !fonts.length ||
    fonts.some(
      (i) =>
        i.rect?.length !== 4 ||
        !i.rect.every(Number.isFinite) ||
        i.rect[0] >= i.rect[2] ||
        i.rect[1] >= i.rect[3] ||
        ![i.height, i.baseline].every(Number.isFinite) ||
        i.height <= 0 ||
        typeof i.horizontal !== 'boolean' ||
        (i.horizontal &&
          (Math.abs(i.rect[3] - i.baseline) > 0.02 ||
            Math.abs(i.rect[3] - i.rect[1] - i.height) > 0.02)) ||
        i.sourceItem?.pageNumber !== page.pageNumber ||
        i.sourceItem.text !== i.text ||
        !Number.isSafeInteger(i.sourceItem.index) ||
        i.sourceItem.index < 0
    ) ||
    new Set(fonts.map((i) => i.sourceItem.index)).size !== fonts.length ||
    rules.some((r) => r?.length !== 4 || !r.every(Number.isFinite) || r[0] > r[2] || r[1] > r[3]) ||
    (page.graphicsBounds ?? []).some(
      (g) =>
        !['image', 'path'].includes(g.kind) ||
        g.normalizedRect?.length !== 4 ||
        !g.normalizedRect.every(Number.isFinite) ||
        g.normalizedRect.some((v) => v < 0 || v > 1) ||
        g.normalizedRect[0] > g.normalizedRect[2] ||
        g.normalizedRect[1] > g.normalizedRect[3]
    )
  )
    return
  const runs = groupPageLines(page, rules)
  const literal = (text) =>
    text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (d) => String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(d))).replace(/\s/gu, '')
  const members = (row) => {
    const intersecting = fonts.filter(
      (i) =>
        i.rect[0] < row.right && i.rect[2] > row.x && i.rect[1] < row.bottom && i.rect[3] > row.y
    )
    if (
      !intersecting.length ||
      intersecting.some(
        (i) =>
          !i.horizontal ||
          i.rect[0] < row.x - 0.02 ||
          i.rect[2] > row.right + 0.02 ||
          i.rect[1] < row.y - 0.02 ||
          i.rect[3] > row.bottom + 0.02
      )
    )
      return
    const anchors = intersecting.filter((i) => Math.abs(i.height - row.fontSize) < 0.02)
    if (
      !anchors.length ||
      anchors.some((i) => Math.abs(i.baseline - anchors[0].baseline) > 0.02) ||
      literal(
        [...intersecting]
          .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
          .map((i) => i.text)
          .join('')
      ) !== literal(row.text)
    )
      return
    return { fonts: intersecting, baseline: anchors[0].baseline }
  }
  const heads = runs.filter(
    (r) => r.text === candidate.lines[0] && Math.abs(r.y - candidate.rect[1]) < 0.02
  )
  if (heads.length !== 1) return
  const start = heads[0],
    em = start.fontSize,
    center = (start.x + start.right) / 2
  if (!(em > 0)) return
  const rows = [start],
    native = [members(start)]
  if (!native[0]) return
  const following = runs
    .filter(
      (r) =>
        r.y > start.y &&
        r.x < Math.max(start.right, candidate.rect[2]) &&
        r.right > Math.min(start.x, candidate.rect[0])
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  // Wider publisher leading is a separate complete-source paragraph proof,
  // not a larger generic join gap. Every row must repeat one measured cadence
  // and center; the native inventory and independent boundaries below remain
  // mandatory. The page bounds the scan instead of a fixed caption row count.
  const wideCadence =
    centered &&
    captionKind(start.text) === 'figure' &&
    following[0] &&
    following[0].y - start.y > em * 1.65 &&
    following[0].y - start.y <= em * 2
  let step
  for (const row of following) {
    if (
      rows.length >= (reference ? candidate.lines.length + 2 : wideCadence ? runs.length : 7) ||
      Math.abs(row.fontSize - em) > 0.02 ||
      (centered
        ? Math.abs((row.x + row.right) / 2 - center) > 0.02
        : Math.abs(row.x - start.x) > 0.02 || row.right > candidate.rect[2] + 0.02)
    )
      break
    const bound = members(row)
    if (!bound) break
    const delta = bound.baseline - native.at(-1).baseline
    if (
      delta < em * 1.15 ||
      delta > em * (wideCadence ? 2 : 1.3) ||
      (step !== undefined && Math.abs(delta - step) > 0.02)
    )
      break
    if (
      captionKind(row.text) &&
      !(
        (reference &&
          rows.length === candidate.lines.length &&
          /^Supplementary\s+Table\s+\d+\.\s+\p{L}/u.test(row.text)) ||
        // A wrapped panel pointer can start a physical row inside this same
        // centered paragraph. The complete native cadence, literal inventory,
        // closed tail and independent graphic remain mandatory below.
        (centered &&
          wideCadence &&
          rows.length >= 3 &&
          /\bin$/u.test(rows.at(-1).text.trim()) &&
          /^(?:Figure|Fig\.)\s+\d+[a-z]\.\s+\p{Lu}/u.test(row.text))
      )
    )
      break
    if (!step) step = delta
    rows.push(row)
    native.push(bound)
  }
  const last = rows.at(-1)
  if (
    rows.length < (wideCadence ? 3 : 2) ||
    (reference && rows.length !== candidate.lines.length + 2)
  )
    return
  const rect = [
    Math.min(...rows.map((r) => r.x)),
    start.y,
    Math.max(...rows.map((r) => r.right)),
    last.bottom
  ]
  const prefix = rows.slice(0, candidate.lines.length)
  if (
    prefix.some((r, n) => r.text !== candidate.lines[n]) ||
    [
      Math.min(...prefix.map((r) => r.x)),
      start.y,
      Math.max(...prefix.map((r) => r.right)),
      prefix.at(-1).bottom
    ].some((v, n) => Math.abs(v - candidate.rect[n]) > 0.02)
  )
    return
  const owned = new Set(native.flatMap((n) => n.fonts))
  const firstIndex = Math.min(...[...owned].map((i) => i.sourceItem.index)),
    lastIndex = Math.max(...[...owned].map((i) => i.sourceItem.index))
  const lower = last.bottom + em * 0.7
  if (
    fonts.some(
      (i) =>
        !owned.has(i) &&
        ((i.sourceItem.index >= firstIndex && i.sourceItem.index <= lastIndex) ||
          (i.rect[0] < rect[2] && i.rect[2] > rect[0] && i.rect[1] < lower && i.rect[3] > rect[1]))
    ) ||
    runs.some(
      (r) =>
        !rows.includes(r) && r.x < rect[2] && r.right > rect[0] && r.y < lower && r.bottom > rect[1]
    ) ||
    rules.some((r) => r[0] < rect[2] && r[2] > rect[0] && r[1] > rect[1] && r[1] < lower) ||
    (page.graphicsBounds ?? []).some((g) => {
      const r = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
      return r[0] < rect[2] && r[2] > rect[0] && r[1] < lower && r[3] > rect[1]
    })
  )
    return
  const closed = /[.!?]$/.test(last.text.trim())
  if (wideCadence && !closed) return
  if (
    !closed &&
    !(
      centered &&
      captionKind(start.text) === 'figure' &&
      !fonts.some(
        (i) => i.rect[0] < rect[2] && i.rect[2] > rect[0] && i.rect[3] > last.bottom + 0.02
      ) &&
      !(page.graphicsBounds ?? []).some(
        (g) =>
          g.normalizedRect[0] * page.width < rect[2] &&
          g.normalizedRect[2] * page.width > rect[0] &&
          g.normalizedRect[3] * page.height > last.bottom
      )
    )
  )
    return
  const graphics = (page.graphicsBounds ?? []).map((g) =>
    g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
  )
  const nextRow = runs
    .filter((r) => !rows.includes(r) && r.y >= last.bottom && r.x < rect[2] && r.right > rect[0])
    .sort((a, b) => a.y - b.y)[0]
  const lowerBoundary = Math.min(
    nextRow?.y ?? page.height,
    ...graphics
      .filter((r) => r[0] < rect[2] && r[2] > rect[0] && r[1] >= last.bottom)
      .map((r) => r[1]),
    ...rules.filter((r) => r[0] < rect[2] && r[2] > rect[0] && r[1] >= last.bottom).map((r) => r[1])
  )
  if (
    fonts.some(
      (i) =>
        !owned.has(i) &&
        i.rect[0] < rect[2] &&
        i.rect[2] > rect[0] &&
        i.rect[1] < lowerBoundary - 0.02 &&
        i.rect[3] > last.bottom
    )
  )
    return
  const emptyUpper = (boundary) =>
    !fonts.some(
      (i) =>
        !owned.has(i) &&
        i.rect[0] < rect[2] &&
        i.rect[2] > rect[0] &&
        i.rect[1] < start.y &&
        i.rect[3] > boundary
    ) &&
    !graphics.some((r) => r[0] < rect[2] && r[2] > rect[0] && r[1] < start.y && r[3] > boundary)
  const envelope = { ...start, x: rect[0], right: rect[2] }
  if (captionKind(start.text) === 'figure') {
    if (
      !provesSingleCaptionRaster(envelope, runs, page) &&
      !provesFragmentedCaptionGraphic(envelope, runs, page, last, 1.02, 0.025)
    )
      return
    const plates = graphics.filter(
      (r) =>
        r[0] < rect[2] &&
        r[2] > rect[0] &&
        r[3] <= start.y &&
        start.y - r[3] < em * 6 &&
        r[2] - r[0] > em * 3 &&
        r[3] - r[1] > em * 3
    )
    if (!plates.length || !emptyUpper(Math.max(...plates.map((r) => r[3])))) return
    if (reference) {
      const body = runs
        .filter((r) => r.y >= lower && r.x < rect[2] && r.right > rect[0])
        .sort((a, b) => a.y - b.y)[0]
      if (
        !body ||
        body.fontSize <= em * 1.05 ||
        captionKind(body.text) ||
        body.y - last.bottom > em * 3 ||
        last.right - last.x >= (rect[2] - rect[0]) * 0.7
      )
        return
    }
  } else {
    const edges = rules.filter(
      (r) =>
        r[1] === r[3] &&
        r[2] - r[0] > em * 10 &&
        Math.abs((r[0] + r[2]) / 2 - center) < 0.02 &&
        ((r[1] < start.y && start.y - r[1] < em * 2) ||
          (r[1] >= lower && r[1] - last.bottom < em * 2))
    )
    const frames = edges.flatMap((edge) =>
      rules
        .filter(
          (r) =>
            r[1] === r[3] &&
            Math.abs(r[0] - edge[0]) < 0.02 &&
            Math.abs(r[2] - edge[2]) < 0.02 &&
            (edge[1] < start.y ? r[1] < edge[1] - em * 2 : r[1] > edge[1] + em * 2)
        )
        .map((other) => [
          edge[0],
          Math.min(edge[1], other[1]),
          edge[2],
          Math.max(edge[1], other[1])
        ])
    )
    if (
      !frames.some((frame) => {
        if (
          new Set(
            fonts
              .filter(
                (i) =>
                  i.horizontal &&
                  i.rect[0] >= frame[0] &&
                  i.rect[2] <= frame[2] &&
                  i.rect[1] >= frame[1] &&
                  i.rect[3] <= frame[3]
              )
              .map((i) => i.baseline)
          ).size < 2
        )
          return false
        if (frame[1] >= lower) return true
        const paint = graphics.filter(
          (r) =>
            r[0] >= frame[0] - page.width / 128 &&
            r[2] <= frame[2] + page.width / 128 &&
            r[1] <= frame[3] &&
            r[3] >= frame[3] &&
            r[3] - r[1] <= page.height / 128 + 0.02 &&
            r[2] - r[0] >= frame[2] - frame[0] - 0.02
        )
        return emptyUpper(Math.max(frame[3], ...paint.map((r) => r[3])))
      })
    )
      return
  }
  return { lines: rows.map((r) => r.text), rect }
}

// Keep an established mathematical head unchanged. Separately painted literal
// marks qualify its physical source row, but are not decoded or inserted into
// that head. Only the two independently closed, centered native tails return.
function recoverNativeRomanLiteralTail(candidate, page, rules, fonts) {
  const finiteRect = (r) =>
    r?.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  if (
    candidate.lines.length !== 1 ||
    !/^TABLE\s+[IVXLCDM]+:\s+\S/u.test(candidate.lines[0]) ||
    !finiteRect(candidate.rect) ||
    ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
    !Number.isSafeInteger(page.pageNumber) ||
    page.pageNumber < 1 ||
    page.invalidGraphicsBounds !== 0 ||
    !fonts.length ||
    fonts.some(
      (i) =>
        !finiteRect(i.rect) ||
        ![i.height, i.baseline].every(Number.isFinite) ||
        i.height <= 0 ||
        typeof i.horizontal !== 'boolean' ||
        (i.horizontal &&
          (Math.abs(i.rect[3] - i.baseline) > 0.02 ||
            Math.abs(i.rect[3] - i.rect[1] - i.height) > 0.02)) ||
        i.sourceItem?.pageNumber !== page.pageNumber ||
        i.sourceItem.text !== i.text ||
        !Number.isSafeInteger(i.sourceItem.index) ||
        i.sourceItem.index < 0
    ) ||
    new Set(fonts.map((i) => i.sourceItem.index)).size !== fonts.length ||
    rules.some((r) => r?.length !== 4 || !r.every(Number.isFinite) || r[0] > r[2] || r[1] > r[3]) ||
    (page.graphicsBounds ?? []).some(
      (g) =>
        !['image', 'path'].includes(g.kind) ||
        !finiteRect(g.normalizedRect) ||
        g.normalizedRect.some((v) => v < 0 || v > 1)
    )
  )
    return
  const runs = groupPageLines(page, rules)
  const heads = runs.filter(
    (r) => r.text === candidate.lines[0] && Math.abs(r.y - candidate.rect[1]) < 0.02
  )
  if (heads.length !== 1) return
  const head = heads[0],
    em = head.fontSize,
    center = (head.x + head.right) / 2
  if (
    !(em > 0) ||
    [head.x, head.y, head.right, head.bottom].some((v, n) => Math.abs(v - candidate.rect[n]) > 0.02)
  )
    return
  const following = runs
    .filter((r) => r.y > head.y && r.x < head.right && r.right > head.x)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = [head, ...following.slice(0, 2)]
  if (
    rows.length !== 3 ||
    !/[.!?]$/.test(rows[2].text.trim()) ||
    rows
      .slice(1)
      .some(
        (r) =>
          captionKind(r.text) ||
          Math.abs(r.fontSize - em) > 0.02 ||
          Math.abs((r.x + r.right) / 2 - center) > 0.02
      )
  )
    return
  const literal = (s) =>
    s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (d) => String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(d))).replace(/\s/gu, '')
  const owned = [],
    marks = []
  for (const [n, row] of rows.entries()) {
    const base = row.y + em
    const parts = fonts.filter(
      (i) =>
        i.rect[0] < row.right && i.rect[2] > row.x && i.rect[1] < row.bottom && i.rect[3] > row.y
    )
    if (
      !parts.length ||
      parts.some(
        (i) =>
          !i.horizontal ||
          i.rect[0] < row.x - 0.02 ||
          i.rect[2] > row.right + 0.02 ||
          i.rect[3] > row.bottom + 0.02 ||
          i.height > em + 0.02 ||
          i.height < em * 0.5
      )
    )
      return
    const raised = parts.filter((i) => Math.abs(i.height - em) < 0.02 && i.baseline < base - 0.02)
    if (n && raised.length) return
    if (
      raised.some(
        (i) =>
          !/^[ˆ\\]$/u.test(i.text) ||
          Math.abs(i.height - em) > 0.02 ||
          base - i.baseline > em * 0.35 ||
          i.rect[1] < row.y - em * 0.35
      )
    )
      return
    if (!parts.some((i) => Math.abs(i.height - em) < 0.02 && Math.abs(i.baseline - base) < 0.02))
      return
    const ordinary = parts.filter((i) => !raised.includes(i))
    if (
      ordinary.some((i) => i.rect[1] < row.y - 0.02) ||
      literal(
        [...ordinary]
          .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
          .map((i) => i.text)
          .join('')
      ) !== literal(row.text)
    )
      return
    for (const mark of raised) {
      const matches = runs.filter(
        (r) =>
          r.text === mark.text &&
          [r.x, r.y, r.right, r.bottom].every((v, k) => Math.abs(v - mark.rect[k]) < 0.02) &&
          Math.abs(r.fontSize - mark.height) < 0.02
      )
      if (matches.length !== 1) return
      marks.push(matches[0])
    }
    owned.push(...parts)
  }
  if (!marks.length || marks.length > 3 || new Set(owned).size !== owned.length) return
  const step = rows[1].y - head.y
  if (step < em * 1.15 || step > em * 1.3 || Math.abs(rows[2].y - rows[1].y - step) > 0.02) return
  const rect = [
    Math.min(...rows.map((r) => r.x)),
    head.y,
    Math.max(...rows.map((r) => r.right)),
    rows[2].bottom
  ]
  const top = Math.min(...owned.map((i) => i.rect[1])),
    bottom = rect[3]
  const next = runs
    .filter(
      (r) =>
        !rows.includes(r) &&
        !marks.includes(r) &&
        r.y >= bottom &&
        r.x < rect[2] &&
        r.right > rect[0]
    )
    .sort((a, b) => a.y - b.y)[0]
  if (!next || captionKind(next.text) || next.y - bottom < em * 0.7 || next.y - bottom > em * 4)
    return
  const footers = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[2] - r[0] > em * 10 &&
      Math.abs((r[0] + r[2]) / 2 - center) < 0.02 &&
      r[1] < top &&
      top - r[1] < em * 2
  )
  const frames = footers.flatMap((footer) =>
    rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          Math.abs(r[0] - footer[0]) < 0.02 &&
          Math.abs(r[2] - footer[2]) < 0.02 &&
          r[1] < footer[1] - em * 2
      )
      .map((r) => [footer[0], r[1], footer[2], footer[1]])
  )
  const graphics = (page.graphicsBounds ?? []).map((g) =>
    g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
  )
  const firstIndex = Math.min(...owned.map((i) => i.sourceItem.index)),
    lastIndex = Math.max(...owned.map((i) => i.sourceItem.index))
  if (
    fonts.some(
      (i) =>
        !owned.includes(i) && i.sourceItem.index >= firstIndex && i.sourceItem.index <= lastIndex
    )
  )
    return
  const upper = frames.filter((frame) => {
    const side = (x) => {
      const segments = rules
        .filter(
          (r) =>
            r[0] === r[2] &&
            Math.abs(r[0] - x) <= em * 0.05 &&
            r[1] >= frame[1] - em * 0.05 &&
            r[3] <= frame[3] + em * 0.05
        )
        .sort((a, b) => a[1] - b[1])
      if (!segments.length || segments.some((r) => Math.abs(r[0] - segments[0][0]) > 0.02)) return
      // Native rectangle strokes inset the side by half their painted width.
      // Derive each side's joins and footer footprint from that measured inset.
      const inset = Math.abs(segments[0][0] - x)
      const joinAllowance = inset * 2 + 0.02
      let end = frame[1]
      for (const segment of segments) {
        if (segment[1] > end + joinAllowance) return
        end = Math.max(end, segment[3])
      }
      if (end >= frame[3] - joinAllowance) return inset
    }
    const sides = [side(frame[0]), side(frame[2])]
    if (
      sides.some((inset) => inset === undefined) ||
      new Set(
        fonts
          .filter(
            (i) =>
              i.horizontal &&
              i.rect[0] >= frame[0] &&
              i.rect[2] <= frame[2] &&
              i.rect[1] >= frame[1] &&
              i.rect[3] <= frame[3]
          )
          .map((i) => i.baseline)
      ).size < 2
    )
      return false
    const strokeInset = Math.max(...sides) + 0.02
    const paint = graphics.filter(
      (r) =>
        r[0] >= frame[0] - page.width / 128 - strokeInset &&
        r[2] <= frame[2] + page.width / 128 + strokeInset &&
        r[1] <= frame[3] &&
        r[3] >= frame[3] &&
        r[3] - r[1] <= page.height / 128 + 0.02 &&
        r[2] - r[0] >= frame[2] - frame[0] - 0.02
    )
    const boundary = Math.max(frame[3], ...paint.map((r) => r[3]))
    return (
      boundary < top &&
      !fonts.some(
        (i) =>
          !owned.includes(i) &&
          i.rect[0] < rect[2] &&
          i.rect[2] > rect[0] &&
          i.rect[1] < next.y - 0.02 &&
          i.rect[3] > boundary
      ) &&
      !graphics.some(
        (r) => r[0] < rect[2] && r[2] > rect[0] && r[1] < next.y - 0.02 && r[3] > boundary
      ) &&
      !rules.some(
        (r) => r[0] < rect[2] && r[2] > rect[0] && r[1] > boundary && r[1] < next.y - 0.02
      ) &&
      !runs.some(
        (r) =>
          !rows.includes(r) &&
          !marks.includes(r) &&
          r.x < rect[2] &&
          r.right > rect[0] &&
          r.y < next.y - 0.02 &&
          r.bottom > boundary
      )
    )
  })
  if (!upper.length) return
  return { lines: [candidate.lines[0], rows[1].text, rows[2].text], rect }
}

function nativeRuledOutdentedTail(caption, page, rules, fonts, context) {
  try {
    return proveNativeRuledOutdentedTail(caption, page, rules, fonts, context)
  } catch {
    return
  }
}

function proveNativeRuledOutdentedTail(caption, page, rules, fonts, context) {
  if (
    caption.lines.length !== 1 ||
    !/,$/u.test(caption.lines[0].trim()) ||
    context?.pageNumber !== page.pageNumber ||
    !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
    JSON.stringify(context.graphicsBounds) !== JSON.stringify(page.graphicsBounds) ||
    JSON.stringify(context.viewport?.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height])
  )
    return
  const first = page.lines.filter(
    (l) =>
      l.text === caption.lines[0] &&
      [l.x, l.y, l.x + l.width, l.y + l.height].every(
        (n, i) => Math.abs(n - caption.rect[i]) < 1e-6
      )
  )
  if (first.length !== 1) return
  const head = first[0],
    em = head.fontSize
  if (!(em > 0) || Math.abs(head.height - em) > 0.02) return
  const viewport = { ...context.viewport, convertToViewportPoint: (x, y) => [x, page.height - y] }
  const native = { ...context, viewport }
  const tokens = native.content?.items
    ?.map((r) => tableTextToken(r, viewport, 0))
    .filter((t) => t.text?.trim())
  if (!tokens) return
  const inventory = nativePageTextPacketInventory(page, tokens, native, true)
  if (!inventory) return
  // Renderer font aliases stay inside this matched context. The current text
  // tokens must independently preserve every whole source index/text/rectangle.
  const current = fonts.filter((f) => f.text?.trim())
  if (
    current.length !== inventory.records.length ||
    inventory.records.some((r) => {
      const matches = current.filter(
        (f) =>
          f.sourceItem?.pageNumber === page.pageNumber &&
          f.sourceItem.index === r.index &&
          f.sourceItem.text === r.r.str &&
          f.text === r.r.str
      )
      return (
        matches.length !== 1 ||
        matches[0].rect?.length !== 4 ||
        matches[0].rect.some((n, i) => Math.abs(n - r.rect[i]) > 1e-6)
      )
    })
  )
    return
  const proof = context.captionPaintProof
  if (
    !Array.isArray(proof?.rules) ||
    !(proof.rulePaintBounds instanceof Map) ||
    !Array.isArray(proof.graphics) ||
    !Array.isArray(proof.identities) ||
    proof.graphics.length !== page.graphicsBounds.length ||
    proof.identities.length !== page.graphicsBounds.length ||
    proof.graphics.some(
      (r, i) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        r[0] >= r[2] ||
        r[1] >= r[3] ||
        proof.identities[i].operationIndex !== page.graphicsBounds[i].operationIndex ||
        proof.identities[i].kind !== page.graphicsBounds[i].kind ||
        proof.identities[i].rect.some(
          (v, n) =>
            Math.abs(
              v - page.graphicsBounds[i].normalizedRect[n] * (n % 2 ? page.height : page.width)
            ) > 1e-6
        ) ||
        r.some((v, n) =>
          n < 2 ? v < proof.identities[i].rect[n] - 1e-6 : v > proof.identities[i].rect[n] + 1e-6
        )
    )
  )
    return
  const nativeRules = proof.rules
  const borders = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > caption.rect[3] &&
        r[1] - caption.rect[3] < em * 5 &&
        r[0] < head.x &&
        head.x - r[0] <= em * 1.8 &&
        Math.abs(r[2] - caption.rect[2]) <= 2 &&
        nativeRules.some((n) => n.every((v, i) => Math.abs(v - r[i]) < 0.02))
    )
    .sort((a, b) => a[1] - b[1])
  if (!borders.length || borders.filter((r) => r[1] === borders[0][1]).length !== 1) return
  const border = borders[0],
    nativeBorder = nativeRules.find((n) => n.every((v, i) => Math.abs(v - border[i]) < 0.02)),
    paint = proof.rulePaintBounds.get(nativeBorder.join(','))
  if (
    !Array.isArray(paint) ||
    paint.length !== 4 ||
    !paint.every(Number.isFinite) ||
    paint[0] > border[0] + 0.02 ||
    paint[2] < border[2] - 0.02 ||
    paint[1] > border[1] ||
    paint[3] < border[1] ||
    paint[1] >= paint[3]
  )
    return
  const frame = [border[0] - 0.02, head.y, Math.max(border[2], caption.rect[2]), paint[1]]
  const over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const rows = page.lines
    .filter((l) => over([l.x, l.y, l.x + l.width, l.y + l.height], frame))
    .sort((a, b) => a.y - b.y)
  if (rows.length !== 2 || rows[0] !== head) return
  const tail = rows[1],
    tailRect = [tail.x, tail.y, tail.x + tail.width, tail.y + tail.height]
  if (
    captionKind(tail.text) ||
    !/^\p{Ll}/u.test(tail.text.trim()) ||
    Math.abs(tail.x - border[0]) > 0.02 ||
    tail.x + tail.width > border[2] ||
    Math.abs(tail.fontSize - em) > 0.02 ||
    Math.abs(tail.height - em) > 0.02 ||
    tail.y <= head.y ||
    tail.y - head.y > em * 1.6 ||
    tail.y < caption.rect[3] ||
    tailRect[3] >= border[1] ||
    border[1] - tailRect[3] > em * 1.5
  )
    return
  const owned = inventory.records.filter((r) => over(r.rect, frame))
  if (
    owned.length !== 2 ||
    owned[0].r.str !== head.text ||
    owned[1].r.str !== tail.text ||
    inventory.records.indexOf(owned[1]) !== inventory.records.indexOf(owned[0]) + 1 ||
    owned[0].r.fontName !== owned[1].r.fontName ||
    owned.some(
      (r, i) =>
        r.rect.some((v, n) => Math.abs(v - (i ? tailRect : caption.rect)[n]) > 1e-6) ||
        ![em, 0, 0, em].every((v, n) => Math.abs(r.r.transform[n] - v) < 1e-6)
    )
  )
    return
  if (proof.graphics.some((r) => over(r, frame))) return
  return { lines: [head.text, tail.text], rect: [tail.x, head.y, caption.rect[2], tailRect[3]] }
}

// Withdraw a generic continuation only when the native stream shows a closed
// small-type caption between two parts of the same independently typed body.
// Font envelopes alone are insufficient: bind every selected carrier to its
// original occurrence and measured glyph baseline before comparing cadence.
function nativeClosedCaptionBodyBoundary(candidate, page, fonts, context) {
  try {
    const own = nativeRecoveryOwnValues(context)
    if (
      !own ||
      candidate.page !== page.pageNumber ||
      candidate.regions ||
      candidate.lines.length < 3 ||
      !/^Figure\s+[A-Z]?\d+:\s/u.test(candidate.lines[0]) ||
      !/[.!?]$/u.test(candidate.lines[0].trim()) ||
      page.renderRotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      own.pageNumber !== page.pageNumber ||
      own.viewport?.width !== page.width ||
      own.viewport?.height !== page.height ||
      JSON.stringify(own.viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height])
    )
      return
    const current = retainNativeRecoveryInputs([candidate, page, fonts, context], own.viewport)
    if (!current) return
    const observed = nativeWholeSourceGlyphObservations(own.content, own.operators)
    if (!observed) return
    const counts = (value, result = new Map()) => {
      if (!value || typeof value !== 'object') return result
      if (Number.isSafeInteger(value.pageNumber) && Number.isSafeInteger(value.index)) {
        const key = value.pageNumber + ':' + value.index
        result.set(key, (result.get(key) ?? 0) + 1)
      }
      for (const part of Object.values(value)) counts(part, result)
      return result
    }
    const rawCounts = counts(own.content),
      tokenCounts = counts(fonts),
      records = []
    for (const observedRecord of observed.records) {
      const { source: raw, index } = observedRecord
      if (!raw.str.trim()) continue
      const source = raw.sourceItem,
        key = page.pageNumber + ':' + index,
        carriers = fonts.filter((f) => f.sourceItem?.index === index),
        projected = tableTextToken(raw, own.viewport, 0),
        // The extraction seam measures at 1.5 before returning page units.
        // Compare that exact projection too; no tolerance substitutes for the
        // independently checked original Source occurrence below.
        scaled = tableTextToken(
          raw,
          {
            transform: [1.5, 0, 0, -1.5, 0, page.height * 1.5],
            convertToViewportPoint: (x, y) => [x * 1.5, page.height * 1.5 - y * 1.5]
          },
          0
        ).rect.map((v) => v / 1.5)
      if (
        source?.pageNumber !== page.pageNumber ||
        source.index !== index ||
        source.text !== raw.str ||
        rawCounts.get(key) !== 1 ||
        tokenCounts.get(key) !== 1 ||
        carriers.length !== 1 ||
        carriers[0].sourceItem.pageNumber !== page.pageNumber ||
        carriers[0].sourceItem.text !== raw.str ||
        carriers[0].text !== raw.str ||
        (JSON.stringify(carriers[0].rect) !== JSON.stringify(projected.rect) &&
          JSON.stringify(carriers[0].rect) !== JSON.stringify(scaled))
      )
        return
      records.push({ ...observedRecord, ...projected, raw })
    }
    if (records.length !== fonts.length) return
    const runs = groupPageLines(page),
      compact = (s) => s.replace(/\s/gu, ''),
      heads = runs.filter(
        (r) => r.text === candidate.lines[0] && Math.abs(r.y - candidate.rect[1]) < 0.02
      )
    if (heads.length !== 1) return
    const head = heads[0],
      em = head.fontSize
    const members = (row) => {
      const selected = records.filter(
        (r) =>
          r.horizontal &&
          Math.abs(r.baseline - row.bottom) < 0.02 &&
          r.rect[0] >= row.x - 0.02 &&
          r.rect[2] <= row.right + 0.02
      )
      if (
        !selected.length ||
        compact(selected.map((r) => r.raw.str).join('')) !== compact(row.text)
      )
        return
      for (const r of selected) {
        const t = r.raw.transform,
          style = own.content.styles?.[r.raw.fontName],
          firstGlyph = r.glyphs[0],
          lastGlyph = r.glyphs.at(-1),
          x = (g, point) => g.transform[0] * point[0] + g.transform[2] * point[1] + g.transform[4]
        if (
          t[1] !== 0 ||
          t[2] !== 0 ||
          t[0] !== r.height ||
          t[3] !== r.height ||
          !style ||
          style.vertical !== false ||
          !Number.isFinite(style.ascent) ||
          !Number.isFinite(style.descent) ||
          !r.glyphs.length ||
          Math.abs(x(firstGlyph, firstGlyph.start) - t[4]) > 0.02 ||
          Math.abs(x(lastGlyph, lastGlyph.end) - t[4] - r.raw.width) > 0.02 ||
          r.glyphs.some((g) => {
            const m = g.transform,
              baseline = m[1] * g.start[0] + m[3] * g.start[1] + m[5]
            return (
              m[1] !== 0 ||
              m[2] !== 0 ||
              Math.abs(baseline - t[5]) > 0.02 ||
              Math.abs(g.size * m[3] - r.height) > 0.02 ||
              g.glyph.isInFont !== true ||
              g.glyph.accent !== null
            )
          })
        )
          return
      }
      return selected
    }
    const first = members(head),
      label = first?.[0],
      description = first?.slice(1),
      prefix = /^Figure\s+[A-Z]?\d+:/u.exec(head.text)?.[0]
    if (
      !label ||
      label.raw.str.trim() !== prefix ||
      !description.length ||
      Math.abs(label.height - em) > 0.02 ||
      description.some(
        (r) =>
          r.raw.fontName === label.raw.fontName ||
          r.height < em * 0.75 ||
          r.height > em * 0.85 ||
          r.raw.fontName !== description[0].raw.fontName ||
          Math.abs(r.height - description[0].height) > 0.02
      )
    )
      return
    const images = page.graphicsBounds
      .filter((g) => g.kind === 'image')
      .map((g) =>
        (g.paintedNormalizedRect ?? g.normalizedRect).map(
          (n, i) => n * (i % 2 ? page.height : page.width)
        )
      )
      .filter(
        (r) =>
          r.every(Number.isFinite) &&
          r[0] >= head.x - em &&
          r[2] <= head.right + em &&
          r[2] - r[0] > (head.right - head.x) * 0.75 &&
          r[3] <= head.y + 0.02 &&
          head.y - r[3] < em
      )
    if (images.length !== 1) return
    const image = images[0],
      before = runs
        .filter((r) => r.bottom < image[1] && r.right > head.x && r.x < head.right)
        .sort((a, b) => a.y - b.y)
        .slice(-2),
      after = runs
        .filter((r) => r.y > head.y && r.x < head.right && r.right > head.x)
        .sort((a, b) => a.y - b.y)
        .slice(0, 2)
    if (
      before.length !== 2 ||
      after.length !== 2 ||
      before.some((r) => captionKind(r.text)) ||
      /[.!?]$/u.test(before[1].text.trim()) ||
      !/^\p{Ll}/u.test(after[0].text.trim()) ||
      image[1] - before[1].bottom > em * 2 ||
      after.some((r, i) => r.text !== candidate.lines[i + 1]) ||
      [...before, ...after].some(
        (r) => Math.abs(r.fontSize - em) > 0.02 || Math.abs(r.x - after[0].x) > 0.02
      )
    )
      return
    const body = [...before, ...after].map(members)
    if (
      body.some(
        (rows) =>
          !rows ||
          !rows.some((r) => r.raw.fontName === label.raw.fontName) ||
          rows.some(
            (r) => Math.abs(r.height - em) > 0.02 || r.raw.fontName === description[0].raw.fontName
          )
      )
    )
      return
    const priorPitch = before[1].bottom - before[0].bottom,
      nextPitch = after[1].bottom - after[0].bottom,
      boundaryPitch = after[0].bottom - head.bottom
    if (
      priorPitch < em * 1.1 ||
      priorPitch > em * 1.4 ||
      Math.abs(nextPitch - priorPitch) > 0.02 ||
      boundaryPitch < description[0].height * 0.95 ||
      boundaryPitch >= em * 0.95 ||
      !current()
    )
      return
    return { lines: [head.text], rect: [head.x, head.y, head.right, head.bottom] }
  } catch {
    // A partial native stream cannot withdraw an existing caption continuation.
  }
}

// A closed caption paragraph may switch to smaller explanatory type above a
// narrower table. Bind all three native rows to a complete four-rail numeric
// frame; this optional candidate recovery grants no new Source permission.
function recoverNativeSmallerTableCaption(candidate, page, rules, fonts, context) {
  try {
    const valid = (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[0] < r[2] &&
        r[1] < r[3],
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6)),
      compact = (s) => s.replace(/\s/gu, '')
    assert(
      candidate.page === page.pageNumber &&
        candidate.lines.length === 1 &&
        /^(?:Extended Data )?Table\s+[A-Z]?\d+\s*[|:]\s+\S/u.test(candidate.lines[0]) &&
        !/[.!?]$/u.test(candidate.lines[0].trim()) &&
        valid(candidate.rect) &&
        page.rotation === 0 &&
        page.invalidGraphicsBounds === 0 &&
        rules.every((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite))
    )
    const runs = groupPageLines(page, rules),
      heads = runs.filter((r) => r.text === candidate.lines[0]),
      head = heads[0],
      em = head?.fontSize
    assert(
      heads.length === 1 &&
        em > 0 &&
        head.right - head.x >= page.width * 0.75 &&
        [head.x, head.y, head.right, head.bottom].every(
          (x, i) => Math.abs(x - candidate.rect[i]) < 1e-6
        )
    )
    const following = runs
        .filter((r) => r.y > head.y && r.x < head.right && r.right > head.x)
        .sort((a, b) => a.y - b.y || a.x - b.x),
      tail = following.slice(0, 2),
      small = tail[0]?.fontSize,
      rows = [head, ...tail],
      last = tail[1]
    assert(
      tail.length === 2 &&
        small >= em * 0.8 &&
        small <= em * 0.9 &&
        tail.every(
          (r, i) =>
            !captionKind(r.text) &&
            Math.abs(r.fontSize - small) < em * 0.01 &&
            Math.abs(r.x - head.x) < em * 0.05 &&
            r.right <= head.right + em * 0.05 &&
            r.y > rows[i].bottom &&
            r.y - rows[i].y >= small &&
            r.y - rows[i].y <= em * 1.4
        ) &&
        !/[.!?]$/u.test(tail[0].text.trim()) &&
        /[.!?]$/u.test(last.text.trim()) &&
        tail[0].right - tail[0].x >= (head.right - head.x) * 0.95 &&
        last.right - last.x >= (head.right - head.x) * 0.25 &&
        last.right - last.x <= (head.right - head.x) * 0.8
    )
    const openings = rules.filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > last.bottom &&
        r[1] - last.bottom <= em * 1.5 &&
        r[0] > head.x &&
        r[2] < head.right &&
        r[2] - r[0] >= (head.right - head.x) * 0.5 &&
        r[2] - r[0] <= (head.right - head.x) * 0.75 &&
        Math.abs((r[0] + r[2] - head.x - head.right) / 2) <= em * 0.1
    )
    assert(openings.length === 1)
    const opening = openings[0],
      rails = rules
        .filter(
          (r) =>
            r[1] === r[3] &&
            Math.abs(r[0] - opening[0]) < 1e-6 &&
            Math.abs(r[2] - opening[2]) < 1e-6 &&
            r[1] >= opening[1] &&
            r[1] - opening[1] <= em * 16
        )
        .sort((a, b) => a[1] - b[1])
    assert(
      rails.length === 4 &&
        rails[1][1] - opening[1] >= em &&
        rails[1][1] - opening[1] <= em * 3 &&
        rails[2][1] - rails[1][1] >= em * 3 &&
        rails[3][1] - rails[2][1] >= em &&
        rails[3][1] - rails[2][1] <= em * 3
    )
    const frame = [opening[0], opening[1], opening[2], rails[3][1]],
      captionRect = [head.x, head.y, Math.max(...rows.map((r) => r.right)), last.bottom],
      corridor = [head.x, head.y, head.right, frame[3]],
      body = runs.filter((r) => hit([r.x, r.y, r.right, r.bottom], frame))
    assert(
      body.length >= 4 &&
        body.length <= 12 &&
        body.every((r) => inside(frame, [r.x, r.y, r.right, r.bottom])) &&
        body.filter((r) => r.bottom < rails[1][1]).length === 1 &&
        body.filter((r) => r.y > rails[1][1] && r.bottom < rails[2][1]).length >= 2 &&
        body.filter((r) => r.y > rails[2][1]).length === 1 &&
        body
          .filter((r) => r.y > rails[1][1])
          .every((r) => (r.text.match(/\d+(?:\.\d+)?/gu) ?? []).length >= 2) &&
        runs.every(
          (r) =>
            !hit([r.x, r.y, r.right, r.bottom], corridor) || rows.includes(r) || body.includes(r)
        ) &&
        rules.every(
          (r) =>
            !hit(
              [
                Math.min(r[0], r[2]) - 1e-6,
                Math.min(r[1], r[3]) - 1e-6,
                Math.max(r[0], r[2]) + 1e-6,
                Math.max(r[1], r[3]) + 1e-6
              ],
              captionRect
            )
        ) &&
        (page.graphicsBounds ?? []).every((g) => {
          const r = g.normalizedRect?.map((x, i) => x * (i % 2 ? page.height : page.width))
          return valid(r) && !hit(r, captionRect)
        })
    )
    const packet = nativePageTextPacketInventory(page, fonts, context, true)
    assert(packet && packet.records.length <= 4096)
    assert(JSON.stringify(page.graphicsBounds) === JSON.stringify(context.graphicsBounds))
    const originalRules = collectTableRules(context.operators, context.viewport)
    assert(
      rules.length === originalRules.length &&
        rules.every((r, index) => r.every((x, i) => Math.abs(x - originalRules[index][i]) < 1e-6))
    )
    for (const row of [...rows, ...body]) {
      const rect = [row.x, row.y, row.right, row.bottom],
        parts = fonts.filter((f) => hit(f.rect, rect)).sort((a, b) => a.rect[0] - b.rect[0])
      assert(
        parts.length &&
          Math.abs(Math.max(...parts.map((f) => f.height)) - row.fontSize) < 1e-6 &&
          compact(parts.map((f) => f.text).join('')) === compact(row.text) &&
          Math.abs(parts[0].rect[0] - row.x) < 1e-6 &&
          Math.abs(parts.at(-1).rect[2] - row.right) < 1e-6 &&
          parts.every(
            (f) =>
              f.horizontal &&
              inside(rect, f.rect) &&
              Math.abs(f.baseline - row.bottom) < 1e-6 &&
              f.height >= row.fontSize * 0.8 &&
              f.height <= row.fontSize &&
              packet.records.some(
                (r) =>
                  r.index === f.sourceItem.index &&
                  r.r.str === f.text &&
                  r.rect.every((x, i) => Math.abs(x - f.rect[i]) < 1e-6)
              )
          )
      )
      if (body.includes(row)) {
        assert(parts.length >= 3)
        if (row.y > rails[1][1]) {
          const numeric = parts.filter((f) => /^[+−-]?\d/u.test(f.text.trim()))
          assert(
            numeric.length >= 2 &&
              numeric.some((f, i) =>
                numeric.slice(i + 1).some((other) => other.rect[0] - f.rect[2] > em)
              )
          )
        }
      }
    }
    return { lines: rows.map((r) => r.text), rect: captionRect }
  } catch {
    return
  }
}

export function applyRuledCaptionRecovery(
  captions,
  ruledCaptions,
  page,
  rules,
  fonts = [],
  context
) {
  const ordinal = (text) =>
    /^(?:Legend to\s+)?(?:Fig(?:ure)?\.?|Chart)\s+([A-Z]?\d+(?:[.-]\d+)*|[A-Z]\.\d+(?:\.\d+)*)(?=[.:\s]|$)/i.exec(
      text
    )?.[1]
  for (const candidate of captions.filter((c) => c.page === page.pageNumber)) {
    const kind = captionKind(candidate.lines[0])
    if (!['table', 'figure'].includes(kind)) continue
    if (
      kind === 'table' &&
      captions.filter((c) => c.page === candidate.page && c.lines[0] === candidate.lines[0])
        .length === 1
    ) {
      const smaller = recoverNativeSmallerTableCaption(candidate, page, rules, fonts, context)
      if (smaller) {
        Object.assign(candidate, smaller)
        continue
      }
    }
    if (
      kind === 'table' &&
      captions.filter((c) => c.page === candidate.page && c.lines[0] === candidate.lines[0])
        .length === 1
    ) {
      const outdented = nativeRuledOutdentedTail(candidate, page, rules, fonts, context)
      if (outdented) {
        Object.assign(candidate, outdented)
        continue
      }
    }
    if (
      kind === 'table' &&
      captions.filter((c) => c.page === candidate.page && c.lines[0] === candidate.lines[0])
        .length === 1
    ) {
      const literalTail = recoverNativeRomanLiteralTail(candidate, page, rules, fonts)
      if (literalTail) {
        Object.assign(candidate, literalTail)
        continue
      }
    }
    const matches = ruledCaptions.filter((c) => {
      if (c.page !== candidate.page || captionKind(c.lines[0]) !== kind) return false
      if (kind === 'table')
        return (
          (c.lines[0] === candidate.lines[0] ||
            nativeRuledScriptCaptionIdentity(candidate, c, page, rules, groupPageLines(page)) ||
            (c.lines[0].replaceAll('ˆ', '') === candidate.lines[0].replaceAll('ˆ', '') &&
              recoverNativeRaisedCaptionFragments(page, c, rules))) &&
          c.rect[1] === candidate.rect[1] &&
          (Math.abs(c.rect[0] - candidate.rect[0]) < 0.01 ||
            (c.rect[0] <= candidate.rect[0] + 0.01 && c.rect[2] >= candidate.rect[2] - 0.01) ||
            provesRuledHeaderExclusion(candidate, c, page, rules, fonts))
        )
      const key = ordinal(candidate.lines[0])
      return (
        key &&
        ordinal(c.lines[0]) === key &&
        Math.abs(c.rect[0] - candidate.rect[0]) < 0.1 &&
        Math.abs(c.rect[1] - candidate.rect[1]) < 0.1
      )
    })
    if (matches.length === 1) {
      Object.assign(candidate, matches[0])
      const roman =
        kind === 'table' &&
        captions.filter((c) => c.page === candidate.page && c.lines[0] === candidate.lines[0])
          .length === 1 &&
        recoverNativeRomanVariableCaption(candidate, page, rules, fonts)
      if (roman) Object.assign(candidate, roman)
      const led = recoverNativeLedMixedCaption(candidate, page, rules, fonts)
      if (led) Object.assign(candidate, led)
      const closed = recoverNativeClosedCaptionBlock(candidate, page, rules, fonts)
      if (closed) {
        Object.assign(candidate, closed)
        // A complete native paragraph owns its interior source rows. Remove
        // only an exact consecutive row projection, not a nearby caption.
        for (const interior of [...captions]) {
          const at = closed.lines.indexOf(interior.lines[0])
          if (
            interior !== candidate &&
            interior.page === candidate.page &&
            at > 0 &&
            interior.lines.every((line, index) => line === closed.lines[at + index]) &&
            interior.rect[0] >= closed.rect[0] &&
            interior.rect[1] > closed.rect[1] &&
            interior.rect[2] <= closed.rect[2] &&
            interior.rect[3] <= closed.rect[3]
          )
            captions.splice(captions.indexOf(interior), 1)
        }
      }
      const boundary =
        kind === 'figure' && nativeClosedCaptionBodyBoundary(candidate, page, fonts, context)
      if (boundary) Object.assign(candidate, boundary)
    }
  }
}

// Some legends print their first line larger than the remaining paragraph.
// Recover only a closed, flush, uniformly spaced smaller-font tail beside an
// independently proved graphic; do not widen the generic font gate.
function findNativeSmallerFigureCaption(start, runs, page) {
  const width = start.right - start.x
  const abbreviatedLead = /\bw\.r\.t\.$/i.test(start.text.trim())
  if (
    captionKind(start.text) !== 'figure' ||
    start.text.length < 35 ||
    (/[.!?]$/.test(start.text.trim()) && !abbreviatedLead) ||
    width < page.width * 0.3
  )
    return
  if (
    runs.some(
      (line) =>
        line.y > start.y &&
        line.y - start.y < start.fontSize * 6 &&
        /^\d+(?:\.\d+)*\s+[A-Z][A-Z\s-]{4,}$/.test(line.text.trim())
    )
  )
    return
  const em = start.fontSize
  const following = runs
    .filter(
      (l) =>
        l.y > start.y + em * 0.2 &&
        l.y - start.y < em * 14 &&
        (Math.abs(l.x - start.x) <= em * 0.2 ||
          (l.x - start.x >= em * 1.8 && l.x - start.x <= em * 4)) &&
        l.right <= start.right + em * 0.2
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const first = following[0]
  if (
    !first ||
    first.fontSize < em * 0.68 ||
    first.fontSize > em * 1.01 ||
    (Math.abs(first.x - start.x) > em * 0.2 &&
      (first.x - start.x < em * 1.8 || first.x - start.x > em * 4)) ||
    first.y < start.y + em * 0.95 ||
    first.y - start.y > em * 3 ||
    first.right > start.right + em * 0.2
  )
    return
  const tail = []
  for (const line of following) {
    const previous = tail.at(-1) ?? start
    if (
      Math.abs(line.fontSize - first.fontSize) > em * 0.02 ||
      Math.abs(line.x - first.x) > em * 0.2 ||
      line.right > start.right + em * 0.2 ||
      line.y < previous.y + first.fontSize * 0.95 ||
      line.y - previous.y > em * 1.5 ||
      (tail.length && Math.abs(line.y - previous.y - first.fontSize * 1.11) > em * 0.4) ||
      captionKind(line.text) ||
      /^\d+(?:\.\d+)*\s+[A-Z][A-Z\s-]{4,}$/.test(line.text.trim()) ||
      /^Notes?\s*[:.]/i.test(line.text)
    )
      break
    tail.push(line)
    if (/[.!?]$/.test(line.text.trim()) && line.right - line.x < (start.right - start.x) * 0.98)
      break
  }
  const last = tail.at(-1)
  if (
    !tail.length ||
    !/[.!?]$/.test(last.text.trim()) ||
    last.right - last.x >= (start.right - start.x) * 0.98 ||
    tail.slice(0, -1).some((l) => l.right - l.x < (start.right - start.x) * 0.85)
  )
    return
  const nearbyGraphics = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' || g.kind === 'path')
    .map((g) =>
      (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (value, axis) => value * (axis % 2 ? page.height : page.width)
      )
    )
    .filter(
      (r) =>
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[2] > r[0] &&
        r[3] > r[1] &&
        r[3] <= start.y + em * 0.1 &&
        start.y - r[3] < em * 7 &&
        Math.min(r[2], start.right) - Math.max(r[0], start.x) >= (start.right - start.x) * 0.35
    )
  const graphicBounds = nearbyGraphics.length
    ? [
        Math.min(...nearbyGraphics.map((r) => r[0])),
        Math.min(...nearbyGraphics.map((r) => r[1])),
        Math.max(...nearbyGraphics.map((r) => r[2])),
        Math.max(...nearbyGraphics.map((r) => r[3]))
      ]
    : undefined
  const singleGraphic =
    graphicBounds &&
    graphicBounds[0] >= start.x - em * 4 &&
    graphicBounds[2] <= start.right + em * 4 &&
    graphicBounds[2] - graphicBounds[0] >= (start.right - start.x) * 0.75 &&
    (graphicBounds[2] - graphicBounds[0]) * (graphicBounds[3] - graphicBounds[1]) >
      page.width * page.height * 0.04
  const compactImages = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' && Array.isArray(g.normalizedRect))
    .map((g) =>
      g.normalizedRect.map((value, axis) => value * (axis % 2 ? page.height : page.width))
    )
    .filter(
      (r) =>
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[2] > r[0] &&
        r[3] > r[1] &&
        r[3] <= start.y + em * 0.1 &&
        start.y - r[3] < em * 7 &&
        Math.min(r[2], start.right) - Math.max(r[0], start.x) >= width * 0.75
    )
  const compactSingleGraphic =
    compactImages.length === 1 &&
    Math.abs((compactImages[0][0] + compactImages[0][2] - start.x - start.right) / 2) <=
      width * 0.08 &&
    compactImages[0][2] - compactImages[0][0] >= width * 0.75 &&
    (compactImages[0][2] - compactImages[0][0]) * (compactImages[0][3] - compactImages[0][1]) >
      page.width * page.height * 0.03
  if (
    !singleGraphic &&
    !compactSingleGraphic &&
    !provesFragmentedCaptionGraphic(
      start,
      runs,
      page,
      last,
      0.98,
      tail.length >= 4 || tail.some((l) => l.bottom - l.y > first.fontSize * 1.2) ? 0.025 : 0.04
    )
  )
    return
  return tail
}

// A publisher can merge its larger figure label with the title while keeping
// the explanatory paragraph in a stable two-thirds type size. Its local
// baseline calibration and unique raster prove this particular paragraph;
// they do not relax the ordinary caption continuation font gate.
function findNativeTwoThirdFigureCaption(start, runs, page) {
  const em = start.fontSize,
    width = start.right - start.x
  if (
    captionKind(start.text) !== 'figure' ||
    start.text.length < 35 ||
    !(em > 0) ||
    width < page.width * 0.5 ||
    !provesSingleCaptionRaster(start, runs, page)
  )
    return
  const following = runs
    .filter(
      (l) => l.y > start.y && l.y - start.y < em * 14 && l.right > start.x && l.x < start.right
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const first = following[0]
  if (
    !first ||
    Math.abs(first.fontSize / em - 2 / 3) > 0.002 ||
    first.y - start.y < em * 1.05 ||
    first.y - start.y > em * 1.2
  )
    return
  const tail = []
  for (const row of following) {
    const prior = tail.at(-1)
    if (
      captionKind(row.text) ||
      ![row.x, row.y, row.right, row.bottom, row.fontSize].every(Number.isFinite) ||
      row.bottom - row.y < row.fontSize - 1e-7 ||
      Math.abs(row.fontSize - first.fontSize) > em * 0.002 ||
      Math.abs(row.x - start.x) > em * 0.02 ||
      row.right > start.right + em * 0.02 ||
      (prior && Math.abs(row.y - prior.y - first.fontSize * 1.1875) > first.fontSize * 0.03)
    )
      break
    tail.push(row)
    if (/[.!?]$/.test(row.text.trim()) && row.right - row.x < width * 0.75) break
  }
  const last = tail.at(-1)
  if (
    tail.length < 2 ||
    tail.length > 12 ||
    !/[.!?]$/.test(last.text.trim()) ||
    last.right - last.x >= width * 0.75 ||
    tail.slice(0, -1).some((l) => l.right - l.x < width * 0.85) ||
    page.lines.some(
      (l) =>
        l.y >= start.y &&
        l.y < last.bottom &&
        l.x < start.right &&
        l.x + l.width > start.x &&
        (l.height < l.fontSize - 1e-7 || l.y + l.height > last.bottom + 1e-7)
    )
  )
    return
  return tail
}

// Panel explanations can form their own paragraph below a one- or two-line
// title. Require native sequential inline keys (or an explicit complete key
// range), independently calibrated leading, and one adjacent raster.
function findNativePanelCaptionParagraph(start, runs, page) {
  const em = start.fontSize
  if (captionKind(start.text) !== 'figure' || !(em > 0)) return
  const following = runs
    .filter(
      (l) =>
        l.y > start.y && l.y - start.y < em * 36 && l.right > start.x && l.x < page.width - start.x
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const panelStart = (text) => /^A(?:\s*[-–]\s*[B-H]|\s*,\s*B)?[.,]\s+\p{Lu}/u.test(text)
  const title = []
  for (const row of following) {
    if (panelStart(row.text)) break
    const previous = title.at(-1) ?? start
    if (
      title.length >= 2 ||
      captionKind(row.text) ||
      Math.abs(row.fontSize - em) > 1e-7 ||
      Math.abs(row.x - start.x) > em * 0.3 ||
      row.y - previous.y < em * 1.15 ||
      row.y - previous.y > em * 1.3
    )
      return
    title.push(row)
  }
  const first = following[title.length],
    previous = title.at(-1) ?? start
  if (
    !first ||
    !panelStart(first.text) ||
    first.y - previous.y < em * 1.85 ||
    first.y - previous.y > em * 2.25
  )
    return
  const body = [],
    candidates = following.slice(title.length)
  let leading
  for (const row of candidates) {
    const prior = body.at(-1)
    if (
      captionKind(row.text) ||
      Math.abs(row.fontSize - em) > 1e-7 ||
      ![row.x, row.y, row.right, row.bottom].every(Number.isFinite) ||
      row.bottom - row.y < em - 1e-7 ||
      Math.abs(row.x - first.x) > em * 0.3 ||
      (prior &&
        (row.y - prior.y < em * 1.2 ||
          row.y - prior.y > em * 1.8 ||
          (leading && Math.abs(row.y - prior.y - leading) > em * 0.12)))
    )
      break
    if (prior && !leading) leading = row.y - prior.y
    body.push(row)
    if (body.length > 28) return
  }
  if (body.length < 2 || !leading || first.y - previous.y - leading < em * 0.08) return
  const range = /^A\s*[-–]\s*([B-H])[.,]\s/u.exec(first.text),
    keys = []
  for (const row of body)
    for (const match of row.text.matchAll(/(?:^|\s)([A-H])(?:\s*,\s*([B-H]))?[.,](?=\s|$)/gu)) {
      if (row !== first && match.index === 0) return
      keys.push(match[1])
      if (match[2]) keys.push(match[2])
    }
  if (!range && (keys.length < 2 || keys.some((key, i) => key.charCodeAt(0) !== 65 + i))) return
  const last = body.at(-1),
    edge = Math.max(start.right, ...title.map((l) => l.right), ...body.map((l) => l.right)),
    left = Math.min(start.x, first.x),
    width = edge - left
  const rasterPage = {
    ...page,
    graphicsBounds: (page.graphicsBounds ?? []).map((g) => {
      const p = g.paintedNormalizedRect,
        n = g.normalizedRect
      return g.kind === 'image' &&
        p?.length === 4 &&
        n?.length === 4 &&
        p.every(Number.isFinite) &&
        p[2] > p[0] &&
        p[3] > p[1] &&
        p.every((v, i) => (i < 2 ? v >= n[i] : v <= n[i]))
        ? { ...g, normalizedRect: p }
        : g
    })
  }
  if (
    width < page.width * 0.5 ||
    edge > page.width - left + em * 0.1 ||
    body.slice(0, -1).some((l) => l.right - l.x < width * 0.8) ||
    (!/[.!?]$/.test(last.text.trim()) &&
      runs.some((l) => l.y >= last.bottom && l.x < edge && l.right > left)) ||
    !provesSingleCaptionRaster({ ...start, x: left, right: edge + em }, runs, rasterPage) ||
    page.lines.some(
      (l) =>
        l.y >= start.y &&
        l.y < last.bottom &&
        l.x < edge &&
        l.x + l.width > left &&
        (l.height < l.fontSize - 1e-7 || l.y + l.height > last.bottom + 1e-7)
    )
  )
    return
  return [...title, ...body]
}

function isNumberedCaptionSectionBoundary(line, n, lines, runs) {
  if (
    n < 2 ||
    !/^\d+(?:\.\d+)+\s+[A-Z][A-Z\s-]{4,}$/.test(line.text.trim()) ||
    !/[.!?]$/.test(lines[n - 1].text.trim())
  )
    return false
  const em = lines[0].fontSize,
    leading = lines[n - 1].y - lines[n - 2].y
  if (line.y - lines[n - 1].y <= Math.max(leading * 1.2, em * 1.2)) return false
  const body = runs
    .filter(
      (l) =>
        l.y >= line.bottom &&
        l.y - line.bottom < em * 5 &&
        Math.abs(l.x - lines[0].x) < em * 0.3 &&
        Math.abs(l.fontSize - em) < em * 0.05 &&
        l.text.length >= 25 &&
        !captionKind(l.text)
    )
    .sort((a, b) => a.y - b.y)
  return body.length >= 2 && body[1].y - body[0].y < em * 1.5
}

function isNativePhotographCaption(start, runs, page, rules) {
  // The probe merges the printed label and title, so bold type is unavailable.
  // This closed noun-title form needs independent source/image ownership.
  if (!/^Figure\s+\d+\s+The illustration of [^.!?]{8,160}\.$/.test(start.text)) return false
  const images = (page.graphicsBounds ?? [])
    .filter((graphic) => graphic.kind === 'image')
    .map((graphic) =>
      graphic.normalizedRect.map((value, axis) => value * (axis % 2 ? page.height : page.width))
    )
    .filter(
      ([left, top, right, bottom]) =>
        right - left >= page.width * 0.2 &&
        bottom - top >= start.fontSize * 3 &&
        (right - left) * (bottom - top) < page.width * page.height * 0.6 &&
        left <= start.x &&
        right >= start.right &&
        Math.abs((left + right - start.x - start.right) / 2) <= start.fontSize &&
        bottom <= start.y + start.fontSize * 0.15 &&
        start.y - bottom <= start.fontSize * 1.5
    )
  // Nested photo panels/icons belong to the outer plate; overlapping independent
  // plates cannot establish a unique owner.
  const outer = images.filter(
    (rect, index) =>
      !images.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          other[0] <= rect[0] &&
          other[1] <= rect[1] &&
          other[2] >= rect[2] &&
          other[3] >= rect[3]
      )
  )
  if (outer.length !== 1) return false
  const [left, , right, bottom] = outer[0]
  if (
    rules.some(
      ([x0, y0, x1, y1]) =>
        y0 === y1 && y0 > bottom && y0 < start.y && x0 < start.right && x1 > start.x
    )
  )
    return false
  if (
    runs.some(
      (line) =>
        line !== start &&
        line.y >= bottom &&
        line.bottom <= start.y &&
        line.right > left &&
        line.x < right
    )
  )
    return false
  return (
    runs.filter(
      (line) =>
        line !== start &&
        line.text.length > 40 &&
        !captionKind(line.text) &&
        line.y > start.bottom &&
        line.fontSize >= start.fontSize * 1.08 &&
        line.fontSize <= start.fontSize * 1.3 &&
        line.right - line.x >= page.width * 0.4
    ).length >= 2
  )
}

// Association can recheck contextual admission without storing a classification
// flag or weakening the lexical prose guard.
export function nativePhotographCaption(page, candidate, rules = []) {
  if (candidate.lines?.length !== 1 || candidate.page !== page.pageNumber) return false
  const runs = groupPageLines(page)
  const starts = runs.filter(
    (line) =>
      line.text === candidate.lines[0] &&
      [line.x, line.y, line.right, line.bottom].every(
        (value, axis) => Math.abs(value - candidate.rect[axis]) <= line.fontSize * 0.01
      )
  )
  return starts.length === 1 && isNativePhotographCaption(starts[0], runs, page, rules)
}

// An unpunctuated label remains a prose reference unless one complete raster
// and a smaller, closed caption paragraph are isolated between body paragraphs.
function findNativeUnpunctuatedRasterCaption(start, runs, page, rules) {
  const em = start.fontSize
  if (
    captionKind(start.text) !== undefined ||
    !/^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+\p{Lu}/u.test(start.text) ||
    page.invalidGraphicsBounds !== 0 ||
    page.graphicsBounds?.length !== 1 ||
    ![page.width, page.height, em].every((v) => Number.isFinite(v) && v > 0)
  )
    return
  const graphic = page.graphicsBounds[0]
  if (
    graphic.kind !== 'image' ||
    !graphic.imageHash ||
    graphic.normalizedRect?.length !== 4 ||
    !graphic.normalizedRect.every(Number.isFinite)
  )
    return
  const [left, top, right, bottom] = graphic.normalizedRect.map(
    (v, n) => v * (n % 2 ? page.height : page.width)
  )
  if (
    left < 0 ||
    top < 0 ||
    right > page.width ||
    bottom > page.height ||
    right - left < em * 8 ||
    bottom - top < em * 4 ||
    bottom > start.y ||
    start.y - bottom > em * 1.5 ||
    Math.abs(left - start.x) > em ||
    Math.abs(right - start.right) > em
  )
    return
  const overlaps = (line) => line.right > left && line.x < right
  const before = runs.filter((l) => overlaps(l) && l.bottom <= top).at(-1)
  if (
    !before ||
    before.fontSize < em * 1.1 ||
    top - before.bottom > em * 3 ||
    !/[.!?]$/.test(before.text)
  )
    return
  const after = runs.filter((l) => overlaps(l) && l.y > start.y)
  const body = after.find((l) => l.fontSize >= em * 1.1)
  if (!body || Math.abs(body.fontSize - before.fontSize) > em * 0.05) return
  const tail = after.filter((l) => l.y < body.y)
  const rows = [start, ...tail]
  if (
    !tail.length ||
    rows.some(
      (l) =>
        ![l.x, l.y, l.right, l.bottom, l.fontSize].every(Number.isFinite) ||
        Math.abs(l.fontSize - em) > em * 0.03 ||
        Math.abs(l.x - start.x) > em * 0.05 ||
        l.right > start.right + em * 0.1 ||
        l.bottom <= l.y
    ) ||
    tail.some((l) => captionKind(l.text)) ||
    !/[.!?]$/.test(tail.at(-1).text) ||
    tail.at(-1).right - start.x > (start.right - start.x) * 0.8 ||
    body.y - tail.at(-1).bottom < em * 0.5 ||
    body.y - tail.at(-1).bottom > em * 2
  )
    return
  const leading = tail[0].y - start.y
  if (
    leading < em ||
    leading > em * 2.6 ||
    tail.some((l, i) => Math.abs(l.y - rows[i].y - leading) > em * 0.05 || l.y < rows[i].bottom)
  )
    return
  // No native text, rule, or unknown source can occupy the raster or bridge
  // either independently established body/caption boundary.
  if (
    runs.some((l) => overlaps(l) && l.y >= before.bottom && l.y < body.y && !rows.includes(l)) ||
    rules.some(
      (r) =>
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        (Math.max(r[0], r[2]) > left &&
          Math.min(r[0], r[2]) < right &&
          Math.max(r[1], r[3]) > before.bottom &&
          Math.min(r[1], r[3]) < body.y)
    )
  )
    return
  return tail
}

function findNativeRasterStripCaption(start, runs, page, rules) {
  const em = start.fontSize
  if (
    captionKind(start.text) !== undefined ||
    !/^Fig\.\s+[A-Z]?\d+(?:\.\d+)*[.:]\s+(?:Our|This|These|Their)\b/u.test(start.text) ||
    page.invalidGraphicsBounds !== 0 ||
    ![page.width, page.height, em].every((v) => Number.isFinite(v) && v > 0)
  )
    return
  const images = (page.graphicsBounds ?? []).filter((g) => g.kind === 'image')
  if (
    images.length < 2 ||
    images.length > 8 ||
    images.some((g) => typeof g.imageHash !== 'string' || !g.imageHash)
  )
    return
  const boxes = images.map((g) =>
    Array.isArray(g.normalizedRect)
      ? g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      : undefined
  )
  if (
    boxes.some(
      (r) =>
        !r ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        r[0] < 0 ||
        r[1] < 0 ||
        r[2] > page.width ||
        r[3] > page.height ||
        r[0] >= r[2] ||
        r[1] >= r[3]
    )
  )
    return
  boxes.sort((a, b) => a[0] - b[0])
  const left = boxes[0][0],
    right = boxes.at(-1)[2],
    top = boxes[0][1],
    bottom = boxes[0][3]
  if (
    right - left < page.width * 0.6 ||
    right - left > page.width * 0.95 ||
    bottom - top < em * 4 ||
    bottom - top > page.height * 0.35 ||
    start.y < bottom ||
    start.y - bottom > em * 1.5 ||
    Math.abs(left - start.x) > em ||
    Math.abs(right - start.right) > em ||
    boxes.some(
      (r, i) =>
        Math.abs(r[1] - top) > em * 0.05 ||
        Math.abs(r[3] - bottom) > em * 0.05 ||
        (i &&
          (r[0] <= boxes[i - 1][0] ||
            r[2] <= boxes[i - 1][2] ||
            Math.abs(r[0] - boxes[i - 1][2]) > em))
    )
  )
    return
  const overlaps = (l) => l.right > left && l.x < right
  const before = runs
    .filter((l) => overlaps(l) && l.bottom <= top)
    .sort((a, b) => b.bottom - a.bottom || b.fontSize - a.fontSize)[0]
  const body = runs
    .filter((l) => overlaps(l) && l.y > start.bottom && l.fontSize >= em * 1.08)
    .sort((a, b) => a.y - b.y || a.x - b.x)[0]
  if (!before || before.fontSize < em * 1.1 || top - before.bottom > em * 4 || !body) return
  const rows = runs.filter((l) => overlaps(l) && l.y >= bottom && l.y < body.y)
  if (
    rows.length < 2 ||
    rows.length > 6 ||
    rows[0] !== start ||
    rows.some(
      (l, i) =>
        ![l.x, l.y, l.right, l.bottom, l.fontSize].every(Number.isFinite) ||
        l.bottom <= l.y ||
        Math.abs(l.fontSize - em) > em * 0.03 ||
        Math.abs(l.x - start.x) > em * 0.05 ||
        l.right > start.right + em * 0.1 ||
        (i &&
          (l.y < rows[i - 1].bottom ||
            l.y - rows[i - 1].y < em ||
            l.y - rows[i - 1].y > em * 1.6 ||
            captionKind(l.text)))
    ) ||
    !/[.!?]$/.test(rows.at(-1).text) ||
    rows.at(-1).right - start.x > (start.right - start.x) * 0.9 ||
    body.y - rows.at(-1).bottom < em * 0.5 ||
    body.y - rows.at(-1).bottom > em * 2 ||
    (page.graphicsBounds ?? []).some((g) => {
      if (
        !Array.isArray(g.normalizedRect) ||
        g.normalizedRect.length !== 4 ||
        !g.normalizedRect.every(Number.isFinite)
      )
        return true
      const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      return r[0] < right && r[2] > left && r[1] < body.y && r[3] > bottom
    }) ||
    rules.some(
      (r) =>
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        (Math.max(r[0], r[2]) > left &&
          Math.min(r[0], r[2]) < right &&
          Math.max(r[1], r[3]) > bottom &&
          Math.min(r[1], r[3]) < body.y)
    )
  )
    return
  return rows.slice(1)
}

// Recheck the same native image band and exact complete paragraph at association time.
// The lexical finite-sentence reference guard deliberately remains unchanged.
export function nativeRasterStripCaption(page, candidate, rules = []) {
  if (candidate.page !== page.pageNumber || !candidate.lines?.length) return false
  const runs = groupPageLines(page, rules),
    starts = runs.filter((l) => l.text === candidate.lines[0])
  if (starts.length !== 1) return false
  const tail = findNativeRasterStripCaption(starts[0], runs, page, rules)
  if (!tail) return false
  const rows = [starts[0], ...tail],
    rect = [
      Math.min(...rows.map((l) => l.x)),
      Math.min(...rows.map((l) => l.y)),
      Math.max(...rows.map((l) => l.right)),
      Math.max(...rows.map((l) => l.bottom))
    ]
  return (
    rows.length === candidate.lines.length &&
    rows.every((l, i) => l.text === candidate.lines[i]) &&
    rect.every((v, i) => Math.abs(v - candidate.rect[i]) < starts[0].fontSize * 0.01)
  )
}

export function nativeUnpunctuatedRasterCaption(page, candidate, rules = []) {
  if (candidate.page !== page.pageNumber || !candidate.lines?.length) return false
  const runs = groupPageLines(page, rules)
  const starts = runs.filter((l) => l.text === candidate.lines[0])
  if (starts.length !== 1) return false
  const tail = findNativeUnpunctuatedRasterCaption(starts[0], runs, page, rules)
  if (!tail) return false
  const rows = [starts[0], ...tail]
  const rect = [
    Math.min(...rows.map((l) => l.x)),
    Math.min(...rows.map((l) => l.y)),
    Math.max(...rows.map((l) => l.right)),
    Math.max(...rows.map((l) => l.bottom))
  ]
  return (
    rows.length === candidate.lines.length &&
    rows.every((l, i) => l.text === candidate.lines[i]) &&
    rect.every((v, i) => Math.abs(v - candidate.rect[i]) < starts[0].fontSize * 0.01)
  )
}

function provesWrappedNativeColumn(start, cue, runs, page, rules) {
  // Broader column ownership is allowed only for tight body leading. A source
  // rule or separately owned plate makes an adjacent title independent.
  if (start.y - cue.bottom > start.fontSize * 0.5) return false
  if (
    rules.some(
      ([x0, y0, x1, y1]) =>
        y0 === y1 && y0 > cue.bottom && y0 < start.y && x0 < start.right && x1 > start.x
    )
  )
    return false
  if (
    (page.graphicsBounds ?? []).some(({ normalizedRect: rect }) => {
      const [left, top, right, bottom] = rect.map(
        (v, axis) => v * (axis % 2 ? page.height : page.width)
      )
      return (
        bottom <= start.y + start.fontSize * 0.1 &&
        start.y - bottom < start.fontSize * 1.5 &&
        bottom - top > start.fontSize * 3 &&
        (right - left) * (bottom - top) < page.width * page.height * 0.6 &&
        Math.min(right, start.right) - Math.max(left, start.x) > (start.right - start.x) * 0.6
      )
    })
  )
    return false
  const row = runs
    .filter(
      (line) =>
        Math.abs(line.y - cue.y) <= start.fontSize * 0.1 &&
        Math.abs(line.fontSize - start.fontSize) <= start.fontSize * 0.03
    )
    .sort((a, b) => a.x - b.x)
  if (
    row.at(-1) !== cue ||
    row.some(
      (line) =>
        line.x < start.x - start.fontSize * 0.1 || line.right > start.right + start.fontSize * 0.15
    ) ||
    Math.abs(cue.right - start.right) > start.fontSize
  )
    return false
  if (row.length === 1)
    return (
      cue.x > start.x &&
      cue.x - start.x <= start.fontSize * 1.05 &&
      cue.right - cue.x >= (start.right - start.x) * 0.75
    )
  // Inline math can split the preceding body row. Its column start and every
  // short intervening native fragment must be proved, without crossing a gutter.
  return (
    row.length <= 5 &&
    row[0].text.length >= 8 &&
    Math.abs(row[0].x - start.x) <= start.fontSize * 0.1 &&
    row.slice(1, -1).every((line) => /^[\p{L}\p{N}\p{Sm}^_/]{1,8}$/u.test(line.text)) &&
    row.every(
      (line, index) =>
        !index ||
        (line.x - row[index - 1].right >= -start.fontSize * 0.1 &&
          line.x - row[index - 1].right <= start.fontSize * 2)
    )
  )
}

// A short all-capital title can be centered independently of its first row.
// Require the separate native header face and an otherwise empty title band;
// the ordinary caption alignment and distance gates remain unchanged.
function findNativeCenteredRuledTitle(start, runs, page, rules) {
  const em = start.fontSize
  if (
    !/^TABLE\s+(?:[A-Z]?\d+|[IVXLCDM]+)[.:]\s+[A-Z]/u.test(start.text) ||
    /[a-z]/u.test(start.text) ||
    /[.!?:]$/u.test(start.text.trim()) ||
    !(em > 0) ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.graphicsBounds) ||
    ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
    page.lines.some((l) => ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite))
  )
    return
  const tails = runs.filter(
    (l) =>
      l !== start &&
      /^[A-Z][A-Z\s-]{3,}$/u.test(l.text) &&
      Math.abs(l.fontSize - em) < em * 0.01 &&
      l.y - start.y >= em * 1.1 &&
      l.y - start.y <= em * 1.3 &&
      Math.abs(l.x + l.right - start.x - start.right) < em * 0.1 &&
      l.x > start.x + em &&
      l.right < start.right - em
  )
  if (tails.length !== 1) return
  const tail = tails[0]
  const openings = rules.filter(
    (r) =>
      r.every(Number.isFinite) &&
      r[1] === r[3] &&
      r[0] < start.x &&
      r[2] > start.right &&
      r[1] - tail.bottom >= em * 1.3 &&
      r[1] - tail.bottom <= em * 2
  )
  if (openings.length !== 1) return
  const opening = openings[0]
  const closing = rules
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        Math.abs(r[0] - opening[0]) < 0.75 &&
        Math.abs(r[2] - opening[2]) < 0.75 &&
        r[1] - opening[1] >= em * 1.5 &&
        r[1] - opening[1] <= em * 4
    )
    .sort((a, b) => a[1] - b[1])[0]
  if (!closing) return
  const source = page.lines.filter(
    (l) =>
      l.text.trim() &&
      l.x < opening[2] &&
      l.x + l.width > opening[0] &&
      l.y + l.height > start.y &&
      l.y < closing[1]
  )
  const title = source.filter((l) => l.y < opening[1])
  if (
    title.length !== 2 ||
    ![start, tail].every((r) =>
      title.some(
        (l) =>
          l.text === r.text &&
          Math.abs(l.x - r.x) < 0.01 &&
          Math.abs(l.y - r.y) < 0.01 &&
          Math.abs(l.x + l.width - r.right) < 0.01
      )
    ) ||
    !source.some((l) => l.y >= opening[1] && /\p{L}/u.test(l.text)) ||
    source.some(
      (l) =>
        l.width <= 0 ||
        l.height <= 0 ||
        l.x < opening[0] ||
        l.x + l.width > opening[2] ||
        (l.y >= opening[1] && l.y + l.height > closing[1])
    ) ||
    rules.some(
      (r) =>
        !r.every(Number.isFinite) ||
        (r[0] < start.right &&
          r[2] > start.x &&
          Math.min(r[1], r[3]) < opening[1] &&
          Math.max(r[1], r[3]) > start.y)
    ) ||
    page.graphicsBounds.some((g) => {
      const r = g.normalizedRect
      return (
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        r.some((v) => v < 0 || v > 1) ||
        r[2] <= r[0] ||
        r[3] <= r[1] ||
        !['image', 'path'].includes(g.kind) ||
        (r[0] * page.width < start.right &&
          r[2] * page.width > start.x &&
          r[1] * page.height < tail.bottom &&
          r[3] * page.height > start.y)
      )
    })
  )
    return
  return [tail]
}

function findNativeBareRomanCaptionBody(start, runs, page, rules) {
  const em = start.fontSize
  if (
    !/^TABLE\s+[IVXLCDM]+\s*$/u.test(start.text.trim()) ||
    !(em > 0) ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.graphicsBounds) ||
    ![page.width, page.height].every((value) => Number.isFinite(value) && value > 0) ||
    page.lines.some(
      (line) => ![line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite)
    )
  )
    return

  const validLine = (line) =>
    [line.x, line.y, line.right, line.bottom, line.fontSize].every(Number.isFinite) &&
    line.right > line.x &&
    line.bottom > line.y &&
    line.x >= 0 &&
    line.y >= 0 &&
    line.right <= page.width &&
    line.bottom <= page.height
  if (!validLine(start)) return

  const center = (line) => (line.x + line.right) / 2
  const startCenter = center(start)
  const nearby = runs
    .filter((line) => line.y > start.y && line.y - start.y <= em * 6)
    .sort((a, b) => a.y - b.y)
  const body = []
  let previous = start
  for (const line of nearby) {
    if (!validLine(line) || Math.abs(line.fontSize - em) >= em * 0.01) break
    const baselineGap = line.y - previous.y
    if (
      baselineGap < em * 1.05 ||
      baselineGap > em * 1.3 ||
      Math.abs(center(line) - startCenter) > em * 0.1 ||
      line.text.length < 30 ||
      captionKind(line.text)
    )
      break
    body.push(line)
    previous = line
    if (/[.!?][\u2019\u201d"')\]]*$/u.test(line.text.trim())) break
  }
  if (body.length < 2 || !/[.!?][\u2019\u201d"')\]]*$/u.test(body.at(-1).text.trim())) return

  const blockLeft = Math.min(start.x, ...body.map((line) => line.x))
  const blockRight = Math.max(start.right, ...body.map((line) => line.right))
  const blockBottom = body.at(-1).bottom
  if (
    page.graphicsBounds.some((graphic) => {
      const rect = graphic?.normalizedRect
      if (
        !Array.isArray(rect) ||
        rect.length !== 4 ||
        !rect.every(Number.isFinite) ||
        rect[0] < 0 ||
        rect[1] < 0 ||
        rect[2] > 1 ||
        rect[3] > 1 ||
        rect[0] >= rect[2] ||
        rect[1] >= rect[3]
      )
        return true
      const [left, top, right, bottom] = rect.map(
        (value, index) => value * (index % 2 ? page.height : page.width)
      )
      return left < blockRight && right > blockLeft && top < blockBottom && bottom > start.y
    })
  )
    return
  const openingGap = rules.filter(
    (rule) =>
      rule.length === 4 &&
      rule.every(Number.isFinite) &&
      rule[1] === rule[3] &&
      rule[2] > rule[0] &&
      rule[0] >= 0 &&
      rule[1] >= 0 &&
      rule[2] <= page.width &&
      rule[3] <= page.height &&
      rule[1] - body.at(-1).bottom >= em * 1.3 &&
      rule[1] - body.at(-1).bottom <= em * 2 &&
      rule[2] - rule[0] >= page.width * 0.7 &&
      rule[0] <= blockLeft + 4 &&
      rule[2] >= blockRight - 4 &&
      Math.abs((rule[0] + rule[2]) / 2 - startCenter) <= em
  )
  if (openingGap.length !== 1) return

  const opening = openingGap[0]
  const nativeTitleLines = page.lines.filter(
    (line) =>
      line.y >= start.y &&
      line.y + line.height <= opening[1] &&
      line.x < opening[2] &&
      line.x + line.width > opening[0]
  )
  if (
    nativeTitleLines.some(
      (line) =>
        ![line.x, line.y, line.width, line.height].every(Number.isFinite) ||
        line.width <= 0 ||
        line.height <= 0 ||
        line.x < 0 ||
        line.y < 0 ||
        line.x + line.width > page.width ||
        line.y + line.height > page.height
    ) ||
    nativeTitleLines.length !== body.length + 1 ||
    ![start, ...body].every((run) =>
      nativeTitleLines.some(
        (line) =>
          line.text === run.text &&
          Math.abs(line.x - run.x) < 0.01 &&
          Math.abs(line.y - run.y) < 0.01 &&
          Math.abs(line.x + line.width - run.right) < 0.01
      )
    )
  )
    return

  return body
}

// A two-em inward continuation is bounded by its own larger section heading.
// This does not borrow the generic outdented-raster paragraph rule: several
// raster panels may precede the caption, and the final row can fill its width.
function findNativeHangingCaptionBeforeSection(start, runs, page, rules) {
  const em = start.fontSize
  if (
    captionKind(start.text) !== 'figure' ||
    start.text.length < 35 ||
    /[.!?:]$/u.test(start.text.trim()) ||
    !(em > 0) ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.graphicsBounds) ||
    page.lines.some((l) => ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite))
  )
    return
  const following = runs.filter((l) => l.y > start.y).sort((a, b) => a.y - b.y || a.x - b.x)
  const tail = following[0],
    boundary = following[1]
  if (
    !tail ||
    !boundary ||
    captionKind(tail.text) ||
    !/^\p{L}/u.test(tail.text) ||
    tail.text.length < 25 ||
    Math.abs(tail.x - start.x - em * 2) > em * 0.05 ||
    Math.abs(tail.fontSize - em) > em * 0.01 ||
    tail.right > start.right + em * 0.05 ||
    tail.y - start.y < em * 1.1 ||
    tail.y - start.y > em * 1.3 ||
    !/^\d+(?:\.\d+)*\s+[A-Z][A-Z\s-]+$/u.test(boundary.text) ||
    boundary.fontSize < em * 1.15 ||
    boundary.fontSize > em * 1.35 ||
    boundary.x < start.x ||
    boundary.right > start.right + em ||
    boundary.y - tail.bottom < em * 1.4 ||
    boundary.y - tail.bottom > em * 4
  )
    return
  const source = page.lines.filter(
    (l) =>
      l.text.trim() &&
      l.x < start.right &&
      l.x + l.width > start.x &&
      l.y + l.height > start.y &&
      l.y < boundary.y
  )
  if (
    source.length !== 2 ||
    ![start, tail].every((r) =>
      source.some(
        (l) =>
          l.text === r.text &&
          Math.abs(l.x - r.x) < 0.01 &&
          Math.abs(l.y - r.y) < 0.01 &&
          Math.abs(l.x + l.width - r.right) < 0.01 &&
          l.width > 0 &&
          l.height > 0
      )
    ) ||
    rules.some(
      (r) =>
        !r.every(Number.isFinite) ||
        (r[0] < start.right &&
          r[2] > start.x &&
          Math.min(r[1], r[3]) < boundary.y &&
          Math.max(r[1], r[3]) > start.bottom)
    )
  )
    return
  let adjacentRaster = false
  for (const graphic of page.graphicsBounds) {
    const r = graphic.normalizedRect
    if (
      !Array.isArray(r) ||
      r.length !== 4 ||
      !r.every(Number.isFinite) ||
      r.some((v) => v < 0 || v > 1) ||
      r[2] <= r[0] ||
      r[3] <= r[1] ||
      !['image', 'path'].includes(graphic.kind)
    )
      return
    const box = r.map((v, i) => v * (i % 2 ? page.height : page.width))
    // Existing caption-start ownership is unchanged. Coarse raster bounds can
    // reach into that first row; none may reach the newly admitted tail band.
    if (box[0] < start.right && box[2] > start.x && box[1] < boundary.y && box[3] > start.bottom)
      return
    if (
      graphic.kind === 'image' &&
      /^[a-f0-9]{64}$/u.test(graphic.imageHash ?? '') &&
      Number.isInteger(graphic.operationIndex) &&
      graphic.operationIndex >= 0 &&
      box[3] <= start.bottom &&
      start.y - box[3] < em * 2 &&
      (box[2] - box[0]) * (box[3] - box[1]) > page.width * page.height * 0.02 &&
      Math.min(box[2], start.right) - Math.max(box[0], start.x) > em * 5
    )
      adjacentRaster = true
  }
  if (adjacentRaster) return [tail]
}

// Complete independently closed native caption rows retain their source fonts and literals.
// A first-line indent can exceed the generic continuation gutter. Admit only
// a complete native paragraph between one independently painted raster and
// its own larger numbered section; do not widen the ordinary outdent guard.
function findNativeIndentedRasterCaption(start, runs, page, rules) {
  const em = start.fontSize
  const valid = (l) =>
    l &&
    typeof l.text === 'string' &&
    [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
    l.width > 0 &&
    l.height > 0 &&
    l.fontSize > 0
  if (
    captionKind(start.text) !== 'figure' ||
    start.text.length < 35 ||
    /[.!?:]$/u.test(start.text.trim()) ||
    !(em > 0) ||
    !Array.isArray(page.lines) ||
    !Array.isArray(page.graphicsBounds) ||
    !Array.isArray(rules) ||
    page.lines.some((l) => l.text.trim() && !valid(l))
  )
    return
  const following = runs
    .filter((l) => l.y > start.y + em * 0.2)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const second = following[0]
  if (
    !second ||
    start.x - second.x <= em * 1.8 ||
    start.x - second.x > em * 2 ||
    Math.abs(second.fontSize - em) > em * 0.01 ||
    second.y - start.y < em * 1.2 ||
    second.y - start.y > em * 1.5
  )
    return
  const rows = [start]
  let boundary
  for (const row of following) {
    if (
      /^\d+(?:\.\d+)*\.?\s+\p{L}/u.test(row.text) &&
      Math.abs(row.x - start.x) < em * 0.05 &&
      row.fontSize >= em * 1.15 &&
      row.fontSize <= em * 1.35
    ) {
      boundary = row
      break
    }
    const previous = rows.at(-1)
    if (
      rows.length >= 8 ||
      captionKind(row.text) ||
      /^Notes?\s*[:.]/iu.test(row.text) ||
      Math.abs(row.x - second.x) > em * 0.05 ||
      Math.abs(row.fontSize - em) > em * 0.01 ||
      row.right > start.right + em * 0.05 ||
      row.y - previous.y < em * 1.2 ||
      row.y - previous.y > em * 1.5
    )
      return
    rows.push(row)
  }
  if (!boundary || rows.length < 2) return
  const last = rows.at(-1),
    left = second.x,
    right = Math.max(...rows.map((r) => r.right)),
    bottom = Math.max(...rows.map((r) => r.bottom))
  if (
    !/[.!?]$/u.test(last.text.trim()) ||
    rows.slice(1, -1).some((r) => r.right - r.x < (right - left) * 0.85) ||
    last.right - last.x >= (right - left) * 0.8 ||
    boundary.y - bottom < em * 1.4 ||
    boundary.y - bottom > em * 2.2
  )
    return
  // Bind every whole original source fragment, including a split first-line
  // superscript. A partial font or a foreign item in the paragraph refuses it.
  const owned = page.lines.filter(
    (l) =>
      l.text.trim() &&
      l.x < right &&
      l.x + l.width > left &&
      l.y < bottom &&
      l.y + l.height > start.y
  )
  if (
    !owned.length ||
    owned.some((l, i) =>
      owned
        .slice(i + 1)
        .some(
          (other) =>
            Math.min(l.x + l.width, other.x + other.width) - Math.max(l.x, other.x) > em * 0.01 &&
            Math.min(l.y + l.height, other.y + other.height) - Math.max(l.y, other.y) > em * 0.01
        )
    ) ||
    owned.some(
      (l) =>
        rows.filter(
          (r) =>
            l.x >= r.x - em * 0.01 &&
            l.x + l.width <= r.right + em * 0.01 &&
            l.y >= r.y - em * 0.01 &&
            l.y + l.height <= r.bottom + em * 0.01
        ).length !== 1
    ) ||
    rows.some((r) => !owned.some((l) => Math.abs(l.x - r.x) < em * 0.01))
  )
    return
  for (const graphic of page.graphicsBounds) {
    const r = graphic?.normalizedRect
    if (
      !Array.isArray(r) ||
      r.length !== 4 ||
      !r.every(Number.isFinite) ||
      r.some((v) => v < 0 || v > 1) ||
      r[2] <= r[0] ||
      r[3] <= r[1] ||
      !['image', 'path'].includes(graphic.kind)
    )
      return
    const box = r.map((v, i) => v * (i % 2 ? page.height : page.width))
    if (box[0] < right && box[2] > left && box[1] < bottom && box[3] > start.y) return
  }
  const images = page.graphicsBounds.filter((g) => g.kind === 'image')
  if (
    images.length !== 1 ||
    !/^[a-f0-9]{64}$/u.test(images[0].imageHash ?? '') ||
    !Number.isInteger(images[0].operationIndex) ||
    images[0].operationIndex < 0 ||
    !provesSingleCaptionRaster({ ...start, x: left, right }, runs, page) ||
    rules.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        (r[0] < right &&
          r[2] > left &&
          Math.min(r[1], r[3]) < bottom &&
          Math.max(r[1], r[3]) > start.y)
    )
  )
    return
  return rows.slice(1)
}

// A larger terminal row can remain in a compact full-width caption. Require
// the complete original paragraph and its independently separated two-column
// body, rather than admitting centered large text by alignment alone.
function findNativeCenteredLargerCaptionTail(start, rows, runs, page, rules) {
  const em = start.fontSize,
    last = rows.at(-1),
    width = start.right - start.x
  if (
    captionKind(start.text) !== 'figure' ||
    rows.length < 4 ||
    rows.length > 7 ||
    width < page.width * 0.8 ||
    /[.!?]$/u.test(last.text.trim()) ||
    !Array.isArray(page.lines) ||
    !Array.isArray(page.graphicsBounds) ||
    !Array.isArray(rules) ||
    rows.some(
      (r, i) =>
        Math.abs(r.x - start.x) > em * 0.01 ||
        Math.abs(r.fontSize - em) > em * 0.01 ||
        r.right > start.right + em * 0.01 ||
        (i < rows.length - 1 && r.right - r.x < width * 0.95) ||
        (i && (r.y - rows[i - 1].y < em * 1.1 || r.y - rows[i - 1].y > em * 1.2))
    ) ||
    last.right - last.x < width * 0.6 ||
    last.right - last.x > width * 0.9
  )
    return
  const tails = runs.filter((r) => !rows.includes(r) && r.y > last.y && r.y < last.bottom)
  if (tails.length !== 1) return
  const tail = tails[0]
  if (
    !/^[a-z][\p{L}\s-]{7,70}\.$/u.test(tail.text) ||
    tail.fontSize < em * 1.24 ||
    tail.fontSize > em * 1.26 ||
    Math.abs((tail.x + tail.right - start.x - start.right) / 2) > em * 0.3 ||
    tail.right - tail.x > width * 0.35 ||
    tail.right - tail.x < width * 0.15 ||
    tail.y - last.y < em * 0.8 ||
    tail.y - last.y > em * 0.85
  )
    return
  const expected = [...rows, tail],
    rect = [start.x, start.y, start.right, tail.bottom]
  const intersects = (r) => r[0] < rect[2] && r[2] > rect[0] && r[1] < rect[3] && r[3] > rect[1]
  const owned = []
  for (const source of page.lines) {
    if (!source || typeof source.text !== 'string') return
    if (!source.text.trim()) continue
    if (
      ![source.x, source.y, source.width, source.height, source.fontSize].every(Number.isFinite) ||
      source.width <= 0 ||
      source.height <= 0 ||
      source.fontSize <= 0
    )
      return
    const box = [source.x, source.y, source.x + source.width, source.y + source.height]
    if (!intersects(box)) continue
    if (source.height < source.fontSize - 1e-7) return
    const matches = expected.filter(
      (r) =>
        r.text === source.text &&
        Math.abs(r.x - box[0]) < 1e-7 &&
        Math.abs(r.y - box[1]) < 1e-7 &&
        Math.abs(r.right - box[2]) < 1e-7 &&
        Math.abs(r.bottom - box[3]) < 1e-7 &&
        Math.abs(r.fontSize - source.fontSize) < 1e-7
    )
    if (matches.length !== 1 || owned.includes(matches[0])) return
    owned.push(matches[0])
  }
  if (owned.length !== expected.length) return
  // The first independent body baseline is two aligned, larger columns,
  // separated from the complete caption by its own paragraph gap.
  const lower = runs
    .filter((r) => r.y >= tail.bottom && r.x < rect[2] && r.right > rect[0])
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const a = lower[0],
    b = lower[1]
  if (
    !a ||
    !b ||
    a.y - tail.bottom < tail.fontSize * 2 ||
    a.y - tail.bottom > tail.fontSize * 3 ||
    Math.abs(a.y - b.y) > em * 0.01 ||
    Math.abs(a.fontSize - tail.fontSize) > em * 0.01 ||
    Math.abs(b.fontSize - tail.fontSize) > em * 0.01 ||
    Math.abs(a.x - start.x) > em * 0.01 ||
    Math.abs(b.right - start.right) > em * 0.01 ||
    [a, b].some(
      (r) =>
        r.text.length < 35 ||
        captionKind(r.text) ||
        r.right - r.x < width * 0.45 ||
        r.right - r.x > width * 0.5
    ) ||
    b.x - a.right < em ||
    b.x - a.right > em * 3
  )
    return
  for (const g of page.graphicsBounds) {
    const r = g?.normalizedRect
    if (
      !Array.isArray(r) ||
      r.length !== 4 ||
      !r.every(Number.isFinite) ||
      r.some((v) => v < 0 || v > 1) ||
      !['path', 'image'].includes(g.kind) ||
      !Number.isInteger(g.operationIndex) ||
      g.operationIndex < 0 ||
      intersects(r.map((v, i) => v * (i % 2 ? page.height : page.width)))
    )
      return
  }
  if (
    rules.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        intersects([
          Math.min(r[0], r[2]),
          Math.min(r[1], r[3]),
          Math.max(r[0], r[2]),
          Math.max(r[1], r[3])
        ])
    ) ||
    !provesFragmentedCaptionGraphic(start, runs, page, tail)
  )
    return
  return tail
}

function findNativeClosedOutdentedFigureCaption(start, runs, page, rules) {
  const em = start.fontSize
  const valid = (l) =>
    l &&
    typeof l.text === 'string' &&
    [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
    l.width > 0 &&
    l.fontSize > 0 &&
    l.height >= l.fontSize - 1e-8
  if (
    captionKind(start.text) !== 'figure' ||
    start.text.length < 35 ||
    !(em > 0) ||
    !Array.isArray(page.lines) ||
    !Array.isArray(page.graphicsBounds) ||
    !Array.isArray(rules) ||
    page.lines.some((l) => l?.text?.trim() && !valid(l))
  )
    return
  const anchors = page.lines.filter(
    (l) =>
      l.text === start.text &&
      l.x === start.x &&
      l.y === start.y &&
      l.x + l.width === start.right &&
      l.fontSize === em
  )
  if (anchors.length !== 1) return
  const first = anchors[0]
  const following = page.lines
    .filter((l) => l.text.trim() && l.y > first.y + em * 0.2)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const second = following[0]
  if (!second) return
  const firstGap = second.y - first.y,
    indent = first.x - second.x,
    base = second.fontSize
  const wide =
    !/[.!?]$/u.test(start.text.trim()) &&
    Math.abs(base - em) < em * 0.01 &&
    indent > 0 &&
    indent <= em * 0.5 &&
    firstGap >= em * 1.6 &&
    firstGap <= em * 1.85
  const styled =
    base >= em * 0.86 &&
    base <= em * 0.94 &&
    indent >= 0 &&
    indent <= em * 0.1 &&
    firstGap >= em * 0.95 &&
    firstGap <= em * 1.5 &&
    /\(a\)/u.test(first.text) &&
    /^\(b\)\s/u.test(second.text)
  if (!wide && !styled) return
  const rows = [first]
  let leading, boundary
  for (const row of following) {
    if (
      captionKind(row.text) ||
      /^Notes?\s*[:.]/iu.test(row.text) ||
      (/^(?:[A-Z]{0,2})?\d+$/u.test(row.text.trim()) &&
        row.y > page.height * 0.88 &&
        Math.abs(row.x + row.width / 2 - page.width / 2) < em * 2)
    ) {
      boundary = row
      break
    }
    if (
      rows.length >= 24 ||
      Math.abs(row.fontSize - base) > em * 0.01 ||
      Math.abs(row.x - second.x) > base * 0.05 ||
      row.x + row.width > start.right + em * 0.2
    )
      return
    const previous = rows.at(-1),
      gap = row.y - previous.y
    if (rows.length > 1) {
      leading ??= gap
      if (
        Math.abs(gap - leading) > base * 0.05 ||
        (wide && (gap < em * 1.6 || gap > em * 1.85)) ||
        (styled && (gap < base * 0.95 || gap > base * 1.5))
      )
        return
    }
    rows.push(row)
  }
  if (rows.length < 3 || !boundary) return
  const last = rows.at(-1),
    left = Math.min(...rows.map((l) => l.x)),
    right = Math.max(...rows.map((l) => l.x + l.width))
  const width = right - left,
    bottom = Math.max(...rows.map((l) => l.y + l.height))
  if (
    !/[.!?]$/u.test(last.text.trim()) ||
    rows.slice(1, -1).some((l) => l.width < width * 0.85) ||
    boundary.y <= bottom ||
    boundary.y - last.y < (leading ?? firstGap) * 1.35
  )
    return
  if (
    wide &&
    (!/^\d+$/u.test(boundary.text.trim()) ||
      boundary.y <= page.height * 0.88 ||
      last.width < width * 0.85)
  )
    return
  if (styled) {
    const keys = [
      ...rows
        .map((l) => l.text)
        .join(' ')
        .matchAll(/\(([a-z])\)/gu)
    ].map((m) => m[1])
    if (
      keys.length < 3 ||
      keys.some((key, i) => key.charCodeAt(0) !== 97 + i) ||
      last.width >= width * 0.8 ||
      captionKind(boundary.text) !== 'table'
    )
      return
    // Native inline panel keys must bind actual raster panels, not a page header rule plus key paths.
    const labels = page.lines.filter(
      (l) =>
        l.y < first.y &&
        first.y - l.y < em * 2.5 &&
        l.text.replace(/\s/gu, '') === keys.map((k) => '(' + k + ')').join('') &&
        l.x >= left &&
        l.x + l.width <= right
    )
    const images = page.graphicsBounds.filter((g) => g?.kind === 'image')
    if (
      labels.length !== 1 ||
      images.length < keys.length ||
      images.some(
        (g) =>
          !/^[a-f0-9]{64}$/u.test(g.imageHash ?? '') ||
          !Number.isInteger(g.operationIndex) ||
          g.operationIndex < 0 ||
          !Array.isArray(g.normalizedRect) ||
          g.normalizedRect.length !== 4 ||
          !g.normalizedRect.every(Number.isFinite) ||
          g.normalizedRect[0] * page.width < left - em ||
          g.normalizedRect[2] * page.width > right + em ||
          g.normalizedRect[3] * page.height > first.y ||
          g.normalizedRect[3] <= g.normalizedRect[1] ||
          g.normalizedRect[2] <= g.normalizedRect[0]
      ) ||
      new Set(images.map((g) => g.operationIndex)).size !== images.length ||
      new Set(images.map((g) => g.normalizedRect.join(','))).size !== images.length
    )
      return
  }
  const selected = new Set(rows)
  if (
    page.lines.some(
      (l) =>
        l.text.trim() &&
        !selected.has(l) &&
        l.x < right &&
        l.x + l.width > left &&
        l.y < bottom &&
        l.y + l.height > first.y
    )
  )
    return
  const rect = [left, first.y, right, bottom]
  for (const graphic of page.graphicsBounds) {
    const r = graphic?.normalizedRect
    if (
      !Array.isArray(r) ||
      r.length !== 4 ||
      !r.every(Number.isFinite) ||
      r[2] <= r[0] ||
      r[3] <= r[1] ||
      !['image', 'path'].includes(graphic.kind)
    )
      return
    const box = r.map((v, i) => v * (i % 2 ? page.height : page.width))
    if (box[0] < right && box[2] > left && box[1] < bottom && box[3] > first.y) return
  }
  if (
    rules.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        (r[1] === r[3] && r[1] > rect[1] && r[1] < rect[3] && r[0] < rect[2] && r[2] > rect[0])
    )
  )
    return
  const envelope = { ...start, x: left, right }
  const lastRun = { ...last, right: last.x + last.width, bottom: last.y + last.height }
  if (wide && !provesSingleCaptionRaster(envelope, runs, page)) return
  if (styled && !provesFragmentedCaptionGraphic(envelope, runs, page, lastRun, 0.8, 0.04)) return
  return rows.slice(1).map((l) => ({ ...l, right: l.x + l.width, bottom: l.y + l.height }))
}

// A wrapped reference completes an unfinished native body row. Require a
// unique same-column, same-font predecessor and an empty physical corridor;
// the reference wording alone never rejects an independently placed caption.
function isNativeBodyReferenceContinuation(start, runs, page, rules, completeRules) {
  // A parenthesis opened by the preceding native row owns its wrapped
  // numbered reference. Require the surrounding uninterrupted body rows;
  // reference wording by itself does not disqualify a detached caption.
  if (
    /^(?:Figure|Fig\.?)\s+[A-Z]?\d+\s+\p{L}[^)]*\)/u.test(start.text) &&
    page.invalidGraphicsBounds === 0 &&
    Array.isArray(page.graphicsBounds)
  ) {
    const em = start.fontSize
    const aligned = runs.filter(
      (r) =>
        r !== start &&
        r.text.length > 30 &&
        !captionKind(r.text) &&
        [r.x, r.y, r.right, r.bottom, r.fontSize, em].every(Number.isFinite) &&
        em > 0 &&
        r.right > r.x &&
        r.bottom > r.y &&
        Math.abs(r.fontSize - em) < em * 0.015 &&
        Math.abs(r.x - start.x) < em * 0.05
    )
    const before = aligned.filter(
      (r) =>
        /\(see\s*$/iu.test(r.text) &&
        Math.abs(r.right - start.right) < em * 0.05 &&
        r.bottom <= start.y &&
        start.y - r.y >= em &&
        start.y - r.y <= em * 1.5
    )
    const after = aligned.filter(
      (r) =>
        r.y > start.y &&
        r.y - start.y >= em &&
        r.y - start.y <= em * 1.5 &&
        r.y >= start.bottom &&
        r.right <= start.right + em * 0.05
    )
    if (before.length === 1 && after.length === 1) {
      const rows = [before[0], start, after[0]],
        box = [start.x, before[0].y, start.right, after[0].bottom]
      const overlaps = (r) =>
        Math.min(r[0], r[2]) < box[2] &&
        Math.max(r[0], r[2]) > box[0] &&
        Math.min(r[1], r[3]) < box[3] &&
        Math.max(r[1], r[3]) > box[1]
      const native = page.lines.filter(
        (l) => l.text?.trim() && overlaps([l.x, l.y, l.x + l.width, l.y + l.height])
      )
      if (
        Math.abs(start.y - before[0].y - (after[0].y - start.y)) < em * 0.03 &&
        native.length === 3 &&
        rows.every(
          (r) =>
            native.filter(
              (n) =>
                n.text === r.text &&
                n.x === r.x &&
                n.y === r.y &&
                n.x + n.width === r.right &&
                n.y + n.height === r.bottom &&
                n.fontSize === r.fontSize
            ).length === 1
        ) &&
        !completeRules.some(
          (r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite) || overlaps(r)
        ) &&
        !page.graphicsBounds.some(
          (g) =>
            !Array.isArray(g.normalizedRect) ||
            g.normalizedRect.length !== 4 ||
            !g.normalizedRect.every(Number.isFinite) ||
            overlaps(g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
        )
      )
        return true
    }
  }
  // An unnumbered lowercase noun may finish an ordinary wrapped sentence.
  // Prove the three complete native rows and their uninterrupted cadence;
  // a detached title, unknown paint, or any separator retains caption status.
  if (
    /^figure\.\s+\p{Lu}/u.test(start.text) &&
    page.invalidGraphicsBounds === 0 &&
    Array.isArray(page.graphicsBounds) &&
    page.graphicsBounds.length === 0
  ) {
    const em = start.fontSize
    const aligned = runs.filter(
      (r) =>
        r !== start &&
        r.text.length > 40 &&
        !captionKind(r.text) &&
        [r.x, r.y, r.right, r.bottom, r.fontSize, em].every(Number.isFinite) &&
        em > 0 &&
        r.right > r.x &&
        r.bottom > r.y &&
        Math.abs(r.fontSize - em) < em * 0.015 &&
        Math.abs(r.x - start.x) < em * 0.05 &&
        Math.abs(r.right - start.right) < em * 0.05
    )
    const before = aligned.filter(
      (r) =>
        start.y - r.y >= em &&
        start.y - r.y <= em * 1.3 &&
        r.bottom <= start.y &&
        !/[.!?:;]$/u.test(r.text.trim())
    )
    const after = aligned.filter(
      (r) => r.y - start.y >= em && r.y - start.y <= em * 1.3 && start.bottom <= r.y
    )
    if (before.length === 1 && after.length === 1) {
      const rows = [before[0], start, after[0]]
      const native = page.lines.filter(
        (r) =>
          r.text?.trim() &&
          r.x < start.right &&
          r.x + r.width > start.x &&
          r.y < after[0].bottom &&
          r.y + r.height > before[0].y
      )
      if (
        Math.abs(start.y - before[0].y - (after[0].y - start.y)) < em * 0.015 &&
        native.length === 3 &&
        rows.every(
          (r) =>
            native.filter(
              (n) =>
                [n.x, n.y, n.width, n.height, n.fontSize].every(Number.isFinite) &&
                n.width > 0 &&
                n.height > 0 &&
                n.text === r.text &&
                n.x === r.x &&
                n.y === r.y &&
                n.x + n.width === r.right &&
                n.y + n.height === r.bottom &&
                n.fontSize === r.fontSize
            ).length === 1
        ) &&
        !completeRules.some(
          (r) =>
            !Array.isArray(r) ||
            r.length !== 4 ||
            !r.every(Number.isFinite) ||
            (Math.min(r[0], r[2]) < start.right &&
              Math.max(r[0], r[2]) > start.x &&
              Math.min(r[1], r[3]) < after[0].bottom &&
              Math.max(r[1], r[3]) > before[0].y)
        )
      )
        return true
    }
  }
  // The indented opening of a complete body paragraph can end immediately
  // before a numbered reference. Its two following native rows, shared right
  // edge and measured leading distinguish it from a detached real caption.
  if (
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\.\s+\p{L}/u.test(start.text) &&
    page.invalidGraphicsBounds === 0 &&
    page.graphicsBounds?.length === 0 &&
    page.lines.every((l) => [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite))
  ) {
    const em = start.fontSize
    const openings = runs.filter(
      (l) =>
        l !== start &&
        l.text.length >= 30 &&
        /\bin(?: the)?$/u.test(l.text.trim()) &&
        !captionKind(l.text) &&
        em > 0 &&
        Math.abs(l.fontSize - em) < em * 0.015 &&
        l.x - start.x >= em &&
        l.x - start.x <= em * 2 &&
        Math.abs(l.right - start.right) < em * 0.05 &&
        start.y - l.y >= em &&
        start.y - l.y <= em * 1.3 &&
        l.bottom <= start.y
    )
    if (openings.length === 1) {
      const opening = openings[0],
        step = start.y - opening.y
      const following = [1, 2].map((n) =>
        runs.filter(
          (l) =>
            Math.abs(l.y - start.y - step * n) < em * 0.015 &&
            Math.abs(l.x - start.x) < em * 0.05 &&
            Math.abs(l.fontSize - em) < em * 0.015 &&
            l.text.length >= 25 &&
            !captionKind(l.text)
        )
      )
      if (following.every((rows) => rows.length === 1)) {
        const middle = following[0][0],
          last = following[1][0]
        const band = [opening, start, middle, last]
        const source = page.lines.filter(
          (l) =>
            l.text.trim() &&
            l.x < start.right + em * 0.05 &&
            l.x + l.width > start.x - em * 0.05 &&
            l.y < last.bottom &&
            l.y + l.height > opening.y
        )
        if (
          Math.abs(middle.right - start.right) < em * 0.05 &&
          last.right - last.x < (start.right - start.x) * 0.8 &&
          /[.!?]$/u.test(last.text.trim()) &&
          !/[.!?]$/u.test(middle.text.trim()) &&
          source.length === 4 &&
          band.every((r) =>
            source.some(
              (l) =>
                l.text === r.text &&
                Math.abs(l.x - r.x) < 0.01 &&
                Math.abs(l.y - r.y) < 0.01 &&
                Math.abs(l.x + l.width - r.right) < 0.01 &&
                l.width > 0 &&
                l.height > 0
            )
          ) &&
          !completeRules.some(
            (r) =>
              !r.every(Number.isFinite) ||
              (r[0] < start.right &&
                r[2] > start.x &&
                Math.min(r[1], r[3]) < last.bottom &&
                Math.max(r[1], r[3]) > opening.y)
          )
        )
          return true
      }
    }
  }
  // A sentence-final reference can wrap to the start of a body line. Its
  // punctuation alone is also valid caption syntax, so require an otherwise
  // uninterrupted, repeated full-width prose paragraph on a paint-free page.
  if (
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\.\s+(?:This|These|That|Those|It|They)\s/u.test(start.text) &&
    page.invalidGraphicsBounds === 0 &&
    page.graphicsBounds?.length === 0
  ) {
    const em = start.fontSize
    const aligned = runs.filter(
      (l) =>
        l !== start &&
        l.text.length >= 30 &&
        !captionKind(l.text) &&
        [l.x, l.y, l.right, l.bottom, l.fontSize, em].every(Number.isFinite) &&
        em > 0 &&
        Math.abs(l.x - start.x) < em * 0.05 &&
        Math.abs(l.right - start.right) < em * 0.05 &&
        Math.abs(l.fontSize - em) < em * 0.015
    )
    const before = aligned.filter(
      (l) => start.y - l.y >= em && start.y - l.y <= em * 1.3 && !/[.!?:;]$/u.test(l.text.trim())
    )
    if (before.length === 1) {
      const step = start.y - before[0].y
      const earlier = aligned.filter((l) => Math.abs(l.y - before[0].y + step) < em * 0.015)
      const after = aligned.filter((l) => Math.abs(l.y - start.y - step) < em * 0.015)
      if (earlier.length === 1 && after.length === 1) {
        const band = [earlier[0], before[0], start, after[0]]
        // A native script can make a preceding prose line's font envelope
        // overlap the next line. Admit only its unique, full-width immediate
        // predecessor at the same measured leading; unrelated ink still vetoes.
        const upstream = aligned.filter(
          (l) =>
            Math.abs(l.y - earlier[0].y + step) < em * 0.015 &&
            !/[.!?:;]$/u.test(l.text.trim()) &&
            l.bottom <= earlier[0].bottom
        )
        if (upstream.length === 1) band.push(upstream[0])
        const source = page.lines.filter(
          (l) =>
            l.text.trim() &&
            l.x < start.right &&
            l.x + l.width > start.x &&
            l.y < after[0].bottom &&
            l.y + l.height > earlier[0].y
        )
        if (
          !runs.some(
            (l) =>
              !band.includes(l) &&
              l.text.trim() &&
              l.x < start.right &&
              l.right > start.x &&
              l.y < after[0].bottom &&
              l.bottom > earlier[0].y
          ) &&
          new Set(source.map((l) => [l.text, l.x, l.y, l.width, l.height, l.fontSize].join('|')))
            .size === source.length &&
          !rules.some(
            (r) =>
              !r.every(Number.isFinite) ||
              (r[1] >= earlier[0].bottom &&
                r[1] <= after[0].y &&
                r[0] < start.right &&
                r[2] > start.x)
          )
        )
          return true
      }
    }
  }
  const tableForReference = /^Table\s+[A-Z]?\d+\s+for\s/u.test(start.text)
  const decimalCommaReference = /^(?:Fig\.?|Figure)\s+\d+(?:\.\d+)+,\s+\p{L}/u.test(start.text)
  // A comparison's object can wrap after "of". The relational continuation,
  // both native column edges and tight leading are required together.
  const comparisonReference =
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+with\s+(?:that|those)\s+of\s+(?:Fig\.?|Figure)\s+[A-Z]?\d+\b/u.test(
      start.text
    )
  const coordinatedReference =
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+and\s+(?:Fig\.?|Figure)\s+[A-Z]?\d+,\s+(?:where|which|that)\b/u.test(
      start.text
    )
  if ((comparisonReference || coordinatedReference) && page.invalidGraphicsBounds !== 0)
    return false
  if (
    !/^(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure|Table)\s+(?:[A-Z]?\d+[a-z]?|[IVXLCDM]+)(?:[.:]\s|\s+and\s+Table|\s+in\s)/u.test(
      start.text
    )
  ) {
    if (
      !tableForReference &&
      !decimalCommaReference &&
      !comparisonReference &&
      !coordinatedReference
    )
      return false
  }
  const em = start.fontSize
  const before = runs.filter(
    (l) =>
      l !== start &&
      l.text.length >= 30 &&
      (comparisonReference ? /\bof$/u : /(?:\bin(?: the)?|\(see)$/u).test(l.text.trim()) &&
      (!(comparisonReference || coordinatedReference) ||
        Math.abs(l.right - start.right) < em * 0.05) &&
      !captionKind(l.text) &&
      Math.abs(l.fontSize - em) < em * 0.015 &&
      (Math.abs(l.x - start.x) < em * 0.05 ||
        (/^Fig\.\s+[A-Z]?\d+[a-z]\.\s/u.test(start.text) &&
          Math.abs(l.x - start.x - em) < em * 0.015 &&
          Math.abs(l.right - start.right) < em * 0.05 &&
          [1, 2].every(
            (n) =>
              runs.filter(
                (row) =>
                  Math.abs(row.x - start.x) < em * 0.05 &&
                  Math.abs(row.fontSize - em) < em * 0.015 &&
                  Math.abs(row.bottom - start.bottom - (start.bottom - l.bottom) * n) <
                    em * 0.015 &&
                  row.text.length >= 30 &&
                  !captionKind(row.text)
              ).length === 1
          ))) &&
      start.y - l.y >= em &&
      start.y - l.y <= em * (decimalCommaReference ? 1.34 : 1.3) &&
      l.bottom <= start.y
  )
  if (before.length !== 1) return false
  const previous = before[0]
  if (decimalCommaReference) {
    const step = start.y - previous.y
    const earlier = runs.filter(
      (row) =>
        row !== start &&
        row !== previous &&
        row.text.length >= 30 &&
        !captionKind(row.text) &&
        Math.abs(row.fontSize - em) < em * 0.015 &&
        row.x >= previous.x - em * 0.05 &&
        row.x <= previous.x + em * 2 &&
        Math.abs(row.right - previous.right) < em * 0.05 &&
        Math.abs(previous.y - row.y - step) < em * 0.015 &&
        row.bottom <= previous.y
    )
    if (earlier.length !== 1) return false
  }
  const source = page.lines.filter(
    (l) =>
      l.x < start.right &&
      l.x + l.width > start.x &&
      l.y <= start.bottom &&
      l.y + l.height >= previous.y
  )
  if (
    new Set(source.map((l) => [l.text, l.x, l.y, l.width, l.height, l.fontSize].join('|'))).size !==
    source.length
  )
    return false
  return (
    !runs.some(
      (l) =>
        l !== previous &&
        l !== start &&
        l.text.trim() &&
        l.y < start.y &&
        l.bottom > previous.y &&
        l.x < start.right &&
        l.right > start.x
    ) &&
    !rules.some(
      (r) =>
        !r.every(Number.isFinite) ||
        (r[1] >= previous.bottom && r[1] <= start.y && r[0] < start.right && r[2] > start.x)
    ) &&
    !(page.graphicsBounds ?? []).some((g) => {
      const r = g.normalizedRect
      if (!r || r.length !== 4 || !r.every(Number.isFinite)) return true
      return (
        r[0] * page.width < start.right &&
        r[2] * page.width > start.x &&
        r[1] * page.height < start.y &&
        r[3] * page.height > previous.bottom
      )
    })
  )
}

// The first native row can merge a larger numbered label with its smaller
// description. A closed, full-width smaller paragraph and a separate native
// plot or table border prove its tail without changing the generic font gate.
function findNativeMixedLabelCaptionParagraph(start, runs, page) {
  const em = start.fontSize,
    width = start.right - start.x
  if (
    !/^(?:Figure|Table)\s+[A-Z]?\d+:\s+\p{L}/u.test(start.text) ||
    !captionKind(start.text) ||
    start.text.length < 45 ||
    width < page.width * 0.5 ||
    /[.!?]$/u.test(start.text.trim()) ||
    page.invalidGraphicsBounds !== 0
  )
    return
  // A tall literal radical can sit above its actual prose baseline. Both
  // adjoining source edges must select exactly one same-baseline prose pair;
  // do not assign it by nearest row or infer a replacement symbol.
  const bridges = new Map(),
    bridgeMembers = new Set(),
    junctions = []
  for (const radical of runs.filter(
    (l) => l.text === '√' && l.y > start.y && l.y - start.y < em * 12
  )) {
    const pairs = runs.flatMap((before) =>
      runs
        .filter(
          (after) =>
            before !== after &&
            before.text.length >= 20 &&
            after.text.length >= 20 &&
            Math.abs(before.x - start.x) < em * 0.05 &&
            after.right <= start.right + em * 0.2 &&
            before.fontSize >= em * 0.78 &&
            before.fontSize <= em * 0.94 &&
            after.fontSize >= before.fontSize &&
            after.fontSize <= before.fontSize * 1.1 &&
            Math.abs(after.bottom - before.bottom) < em * 0.01 &&
            Math.abs(after.y - before.y) < em * 0.05 &&
            radical.fontSize >= before.fontSize &&
            radical.fontSize <= before.fontSize * 1.1 &&
            radical.right - radical.x < before.fontSize * 1.1 &&
            radical.x >= before.right &&
            radical.x - before.right < before.fontSize * 0.35 &&
            after.x >= radical.right &&
            after.x - radical.right < before.fontSize * 0.1 &&
            before.bottom - radical.bottom > before.fontSize * 0.6 &&
            before.bottom - radical.bottom < before.fontSize * 1.2
        )
        .map((after) => ({ before, after }))
    )
    if (pairs.length !== 1) continue
    const { before, after } = pairs[0]
    if ([before, radical, after].some((l) => bridgeMembers.has(l))) return
    junctions.push({ before, radical, after })
    bridges.set(before, {
      ...before,
      text: before.text + ' ' + radical.text + ' ' + after.text,
      y: Math.min(before.y, after.y),
      right: after.right,
      bottom: before.bottom,
      fontSize: Math.max(before.fontSize, after.fontSize)
    })
    for (const l of [before, radical, after]) bridgeMembers.add(l)
  }
  const paragraphRuns = runs.flatMap((l) =>
    bridges.has(l) ? [bridges.get(l)] : bridgeMembers.has(l) ? [] : [l]
  )
  const following = paragraphRuns
    .filter(
      (l) => l.y > start.y + 2 && l.y - start.y < em * 12 && l.right > start.x && l.x < start.right
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const tail = []
  for (const row of following) {
    const previous = tail.at(-1) ?? start
    if (
      Math.abs(row.x - start.x) > em * 0.05 ||
      row.right > start.right + em * 0.2 ||
      row.fontSize < em * 0.78 ||
      row.fontSize > em * 0.94 ||
      row.y - previous.y < em * 0.75 ||
      row.y - previous.y > em * 1.35 ||
      captionKind(row.text) ||
      /^Notes?\s*[:.]/iu.test(row.text)
    )
      break
    tail.push(row)
    if (/[.!?]$/u.test(row.text.trim()) && row.right - row.x < width * 0.99) break
  }
  const last = tail.at(-1)
  if (
    tail.length < 2 ||
    !/[.!?]$/u.test(last.text.trim()) ||
    last.right - last.x >= width * 0.99 ||
    tail.slice(0, -1).some((l) => l.right - l.x < width * 0.85)
  )
    return
  const band = [start, ...tail]
  if (
    paragraphRuns.some(
      (l) =>
        !band.includes(l) &&
        l.text.trim() &&
        l.x < start.right &&
        l.right > start.x &&
        l.y < last.bottom + em &&
        l.bottom > start.y - em * 0.3
    )
  )
    return
  const fragments = page.lines.filter(
    (l) =>
      l.text.trim() &&
      l.x < start.right &&
      l.x + l.width > start.x &&
      l.y < last.bottom &&
      l.y + l.height > start.y
  )
  if (
    fragments.some(
      (l) =>
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
        l.width <= 0 ||
        l.height <= 0 ||
        l.fontSize <= 0 ||
        l.x < start.x - em * 0.05 ||
        l.x + l.width > start.right + em * 0.2 ||
        l.fontSize > em * 1.01
    ) ||
    new Set(fragments.map((l) => [l.text, l.x, l.y, l.width, l.height, l.fontSize].join('|')))
      .size !== fragments.length
  )
    return
  const graphics = page.graphicsBounds ?? []
  const junctionPaths = new Map()
  if (
    graphics.some((g) => {
      if (
        !Array.isArray(g.normalizedRect) ||
        g.normalizedRect.length !== 4 ||
        !g.normalizedRect.every(Number.isFinite) ||
        g.normalizedRect.some((v) => v < 0 || v > 1) ||
        !['path', 'image'].includes(g.kind)
      )
        return true
      const r = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
      if (!(r[0] < start.right && r[2] > start.x && r[1] < last.bottom && r[3] > start.y))
        return false
      // The existing quantized path box may touch a proved literal junction.
      // Accept one bounded local path only; this neither identifies its ink
      // nor widens ownership to another formula or graphic in the paragraph.
      const matches = junctions.filter(
        ({ before, radical, after }) =>
          band.includes(bridges.get(before)) &&
          g.kind === 'path' &&
          r[2] > r[0] &&
          r[3] > r[1] &&
          Math.abs(r[0] - radical.right) <= page.width / 256 &&
          r[2] <= after.x + before.fontSize * 3 &&
          r[1] >= before.y - page.height / 256 &&
          r[3] <= before.bottom &&
          r[3] - r[1] <= (page.height / 256) * 2
      )
      if (matches.length !== 1 || junctionPaths.has(matches[0])) return true
      junctionPaths.set(matches[0], g)
      return false
    })
  )
    return
  if (captionKind(start.text) === 'figure') {
    if (
      !provesFragmentedCaptionGraphic(start, runs, page, last, 0.99, 0.025) &&
      !provesSingleCaptionRaster(start, runs, page)
    )
      return
  } else if (
    !graphics.some((g) => {
      if (g.kind !== 'path') return false
      const r = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
      return (
        r[0] >= start.x - em &&
        r[2] <= start.right + em &&
        r[2] - r[0] >= width * 0.5 &&
        r[3] - r[1] <= em * 1.05 &&
        r[3] <= start.y &&
        start.y - r[3] <= em * 2
      )
    })
  )
    return
  return tail
}

// A colon title may legitimately open with a sentence connector. Re-admit
// only a closed caption paragraph behind independent native plots, with no
// prose or graphic crossing its isolated paragraph. Pure classification stays
// conservative for the same sentence in a body paragraph.
function isNativeIsolatedColonCaption(start, runs, page) {
  const authorLed =
    /^Figure\s+[A-Z]?\d+:\s+(?:We|Our)\s+(?:show|present|compare|evaluate|report|describe|visuali[sz]e|plot)\b/u.test(
      start.text
    )
  if (
    (!authorLed && !/^Figure\s+[A-Z]?\d+:\s+(?:As|For|In)\b/u.test(start.text)) ||
    page.invalidGraphicsBounds !== 0 ||
    start.right - start.x < page.width * 0.5
  )
    return false
  const em = start.fontSize,
    tail = []
  for (const row of runs
    .filter(
      (l) => l.y > start.y + 2 && l.y - start.y < em * 5 && l.x < start.right && l.right > start.x
    )
    .sort((a, b) => a.y - b.y)) {
    const previous = tail.at(-1) ?? start
    if (
      Math.abs(row.x - start.x) > em * 0.02 ||
      Math.abs(row.fontSize - em) > em * 0.015 ||
      row.y - previous.y < em ||
      row.y - previous.y > em * 1.3 ||
      row.right > start.right + em * 0.2 ||
      captionKind(row.text)
    )
      break
    tail.push(row)
    if (/[.!?]$/u.test(row.text.trim()) && row.right - row.x < (start.right - start.x) * 0.98) break
  }
  const last = tail.at(-1)
  if (
    (authorLed ? tail.length < 1 || tail.length > 4 : tail.length !== 2) ||
    !/[.!?]$/u.test(last.text.trim()) ||
    !provesFragmentedCaptionGraphic(start, runs, page, last, 0.98)
  )
    return false
  const band = [start, ...tail]
  if (authorLed) {
    const native = page.lines.filter(
      (line) =>
        line.text?.trim() &&
        line.x < start.right &&
        line.x + line.width > start.x &&
        line.y < last.bottom &&
        line.y + line.height > start.y
    )
    if (
      native.length !== band.length ||
      band.some(
        (row) =>
          native.filter(
            (line) =>
              line.text === row.text &&
              line.x === row.x &&
              line.y === row.y &&
              line.x + line.width === row.right &&
              line.y + line.height === row.bottom &&
              line.fontSize === row.fontSize
          ).length !== 1
      )
    )
      return false
  }
  return (
    !runs.some(
      (l) =>
        !band.includes(l) &&
        l.text.trim() &&
        l.x < start.right &&
        l.right > start.x &&
        l.y < last.bottom + em &&
        l.bottom > start.y - em * 0.2
    ) &&
    !(page.graphicsBounds ?? []).some((g) => {
      const r = g.normalizedRect
      if (!r || r.length !== 4 || !r.every(Number.isFinite)) return true
      return (
        r[0] * page.width < start.right &&
        r[2] * page.width > start.x &&
        r[1] * page.height < last.bottom &&
        r[3] * page.height > start.y
      )
    })
  )
}

function provesNativeBodyReference(start, runs, page, rules) {
  const em = start.fontSize,
    width = start.right - start.x,
    sameType = (line) => Math.abs(line.fontSize - em) <= em * 0.03,
    plate = (page.graphicsBounds ?? []).some(
      ({ normalizedRect: r }) =>
        r?.length === 4 &&
        r.every(Number.isFinite) &&
        r[3] * page.height <= start.y + em * 0.2 &&
        start.y - r[3] * page.height < em * 4 &&
        (r[3] - r[1]) * page.height > em * 2 &&
        Math.min(r[2] * page.width, start.right) - Math.max(r[0] * page.width, start.x) >
          width * 0.6
    )
  if (!(em > 0) || !(width > em * 10) || plate) return false
  // An infinitive after a table reference can continue a transitive body cue.
  // Keep independently separated titles, even when their text is identical.
  if (/^(?:Table|Tab\.?)\s+[A-Z]?\d+\s+to\s+[a-z]/u.test(start.text))
    return runs.some(
      (cue) =>
        cue.text.length >= 25 &&
        /\b(?:we|they)\s+(?:provide|use|include|present)$/iu.test(cue.text.trim()) &&
        sameType(cue) &&
        Math.abs(cue.x - start.x) <= em * 0.1 &&
        Math.abs(cue.right - start.right) <= em * 0.15 &&
        cue.bottom <= start.y &&
        start.y - cue.bottom <= em * 0.5 &&
        !rules.some(
          ([x0, y0, x1, y1]) =>
            y0 === y1 && y0 >= cue.bottom && y0 <= start.y && x0 < start.right && x1 > start.x
        )
    )
  if (!/^(?:Figure|Fig\.?)\s+\d+\s*\([a-z]\),\s+[a-z]/u.test(start.text)) return false
  // Across a column break the cue is below the reference. Prove both body
  // columns and their endpoints instead of treating arbitrary nearby text as
  // the preceding line, or excluding descriptive panel captions by wording.
  return runs.some((cue) => {
    const gutter = start.x - cue.right
    if (
      !/\b(?:shown|illustrated|described)\s+in$/iu.test(cue.text.trim()) ||
      cue.text.length < 25 ||
      !sameType(cue) ||
      gutter < em ||
      gutter > em * 5 ||
      Math.abs(cue.right - cue.x - width) > em * 0.2 ||
      cue.y < start.y + em * 2
    )
      return false
    const left = runs
      .filter(
        (line) =>
          sameType(line) &&
          line.text.length >= 20 &&
          line.x >= cue.x - em * 0.1 &&
          line.x <= cue.x + em * 1.1 &&
          line.right <= cue.right + em * 0.15 &&
          line.y >= start.y - em * 0.15
      )
      .sort((a, b) => a.y - b.y)
    const right = runs
      .filter(
        (line) =>
          sameType(line) &&
          line.text.trim().length >= 3 &&
          Math.abs(line.x - start.x) <= em * 0.1 &&
          line.right <= start.right + em * 0.15 &&
          line.y >= start.y - em * 0.15 &&
          line.y <= start.y + em * 3
      )
      .sort((a, b) => a.y - b.y)
    return (
      left.length >= 3 &&
      left.at(-1) === cue &&
      Math.abs(left[0].y - start.y) <= em * 0.15 &&
      right.length >= 3 &&
      right[0] === start &&
      left.every((line) => !captionKind(line.text)) &&
      right.slice(0, 2).every((line) => line.right - line.x >= width * 0.75) &&
      right.slice(1, 3).every((line) => !captionKind(line.text)) &&
      [left, right.slice(0, 3)].every((column) =>
        column.every(
          (line, i) =>
            !i || (line.y - column[i - 1].y >= em * 0.85 && line.y - column[i - 1].y <= em * 1.5)
        )
      ) &&
      !runs.some(
        (line) =>
          sameType(line) &&
          Math.abs(line.x - start.x) <= em * 0.1 &&
          line.y < start.y - em * 0.15 &&
          start.y - line.y < em * 2
      ) &&
      !page.lines.some(
        (line) =>
          line.text.trim().length > 2 &&
          line.x < cue.right &&
          line.x + line.width > cue.x &&
          line.y >= cue.bottom + em * 0.1
      ) &&
      !rules.some(
        ([x0, y0, x1, y1]) =>
          y0 === y1 &&
          y0 >= start.y - em &&
          y0 <= right[2].bottom &&
          x0 < start.right &&
          x1 > start.x
      )
    )
  })
}

// Complete a split numbered reference only inside an existing
// caption with repeated native leading and an independently declared next heading.
function nativeWrappedCaptionReference(page, start, rows, runs, next, rules = []) {
  const em = start.fontSize,
    prev = rows.at(-1),
    prior = rows.at(-2),
    finite = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
  if (
    !/^(?:Fig\.?|Figure)\s+/iu.test(start.text) ||
    ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
    !next ||
    rows.length < 2 ||
    !prior ||
    !(em > 0) ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.lines) ||
    !Array.isArray(page.graphicsBounds) ||
    !Array.isArray(page.headingCandidates)
  )
    return false
  if (
    !/\b(?:Table|Tab\.?|Figure|Fig\.?)$/iu.test(prev.text.trim()) ||
    !/^\d+(?:\.\d+)*\.$/u.test(next.text.trim()) ||
    /[.!?]$/u.test(prior.text.trim())
  )
    return false
  const pitch = prev.y - prior.y,
    gap = next.y - prev.y
  if (
    pitch < em ||
    pitch > em * 2.25 ||
    Math.abs(gap - pitch) > em * 0.05 ||
    Math.abs(next.x - start.x) > em * 0.05 ||
    Math.abs(next.fontSize - em) > em * 0.01 ||
    next.right - next.x >= em * 4 ||
    Math.abs(prev.right - start.right) > em * 0.05 ||
    Math.abs(prev.x - start.x) > em * 0.05
  )
    return false
  const selected = [...rows, next],
    raw = []
  if (
    selected.some(
      (l) => Math.abs(l.fontSize - em) > em * 0.01 || Math.abs(l.bottom - l.y - em) > em * 0.01
    )
  )
    return false
  for (const row of selected) {
    const matches = page.lines.filter(
      (l) =>
        l.text === row.text &&
        l.x === row.x &&
        l.y === row.y &&
        l.x + l.width === row.right &&
        l.y + l.height === row.bottom &&
        l.fontSize === row.fontSize
    )
    if (matches.length !== 1) return false
    raw.push(matches[0])
  }
  const following = runs
    .filter((l) => l.y > next.y && l.x < start.right && l.right > start.x)
    .sort((a, b) => a.y - b.y)[0]
  if (
    !following ||
    following.y < next.bottom ||
    following.y - next.y <= pitch ||
    !/^\d+(?:\.\d+)+\s+\p{Lu}/u.test(following.text) ||
    page.headingCandidates.filter(
      (l) =>
        l.text === following.text &&
        l.x === following.x &&
        l.y === following.y &&
        l.x + l.width === following.right
    ).length !== 1
  )
    return false
  const valid = (l) =>
    [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
    l.width > 0 &&
    l.height > 0 &&
    l.fontSize > 0
  if (
    page.lines.some(
      (l) =>
        l.text?.trim() &&
        (!valid(l) ||
          (!raw.includes(l) &&
            l.x < start.right &&
            l.x + l.width > start.x &&
            l.y < next.bottom &&
            l.y + l.height > start.y))
    )
  )
    return false
  if (
    rules.some(
      (r) =>
        !finite(r) ||
        (r[0] < start.right &&
          r[2] > start.x &&
          Math.max(r[1], r[3]) > start.y &&
          Math.min(r[1], r[3]) < next.bottom)
    )
  )
    return false
  if (page.graphicsBounds.length !== 1) return false
  const g = page.graphicsBounds[0],
    r = g.normalizedRect
  if (
    g.kind !== 'image' ||
    !Number.isSafeInteger(g.operationIndex) ||
    g.operationIndex < 0 ||
    !/^[0-9a-f]{64}$/.test(g.imageHash ?? '') ||
    !finite(r) ||
    r[2] <= r[0] ||
    r[3] <= r[1] ||
    r.some((v) => v < 0 || v > 1)
  )
    return false
  const box = r.map((v, i) => v * (i % 2 ? page.height : page.width))
  return (
    box[0] >= start.x &&
    box[2] <= start.right &&
    box[3] <= start.y &&
    start.y - box[3] < em * 2 &&
    !runs.some(
      (l) =>
        !selected.includes(l) &&
        l.x < box[2] &&
        l.right > box[0] &&
        l.y < start.y &&
        l.bottom > box[3]
    )
  )
}

// A complete native prose paragraph can wrap a numbered reference after an
// unfinished grammatical cue. Calibrate leading on three independent preceding
// source rows; a larger gap alone never identifies prose. Foreign text uses all
// four corners of its native font envelope, including rotated chart axes. This
// proves local paragraph ownership, not a full-page loaded-glyph inventory.
function isNativeWrappedBodyReference(candidate, page, context, rules) {
  try {
    return proveNativeWrappedBodyReference(candidate, page, context, rules) === true
  } catch {
    return false
  }
}
function proveNativeWrappedBodyReference(candidate, page, context, rules = []) {
  const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
    hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const raw = context?.content?.items,
    m = context?.viewport?.transform,
    creditReference = /^(?:Fig\.|Figure)\s+\d+[A-Z]:/u.test(candidate?.lines?.[0] ?? ''),
    sectionReference = /^(?:Figure|Fig\.)\s+\d+\s+and\s+Table\s+\d+\s+\p{Ll}/u.test(
      candidate?.lines?.[0] ?? ''
    )
  if (
    !candidate ||
    candidate.regions ||
    candidate.page !== page?.pageNumber ||
    context?.pageNumber !== page.pageNumber ||
    !finite(m, 6) ||
    m.some((v, i) => v !== [1, 0, 0, -1, 0, page.height][i]) ||
    context.viewport.width !== page.width ||
    context.viewport.height !== page.height ||
    !Array.isArray(raw) ||
    !Array.isArray(page.lines) ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.graphicsBounds) ||
    !finite(candidate.rect, 4) ||
    !Array.isArray(candidate.lines) ||
    !candidate.lines.length ||
    (!/^(?:Figure|Fig\.)\s+[A-Z]?\d+\.\s+\p{Lu}/u.test(candidate.lines[0]) &&
      !sectionReference &&
      !creditReference)
  )
    return
  const records = [],
    keys = new Set()
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    if (!r || typeof r !== 'object') return
    if (!('str' in r)) continue
    const s = r.sourceItem
    if (
      typeof r.str !== 'string' ||
      s?.pageNumber !== page.pageNumber ||
      s.index !== i ||
      s.text !== r.str ||
      keys.has(i) ||
      ['sourceToken', 'sourceSegment', 'sourceItems', 'sourceSegments'].some(
        (k) => r[k] !== undefined
      )
    )
      return
    keys.add(i)
    if (!r.str.trim()) continue
    const t = r.transform,
      f = context.content.styles?.[r.fontName]
    if (
      !finite(t, 6) ||
      !f ||
      f.vertical !== false ||
      ![f.ascent, f.descent, r.width, r.height].every(Number.isFinite) ||
      f.ascent <= 0 ||
      f.ascent <= f.descent ||
      f.descent > 0 ||
      r.width <= 0 ||
      r.height <= 0 ||
      r.dir !== 'ltr'
    )
      return
    const u = Math.hypot(t[0], t[1]),
      v = Math.hypot(t[2], t[3])
    if (!(u > 0 && v > 0) || Math.abs(t[0] * t[2] + t[1] * t[3]) > u * v * 1e-6) return
    const ps = []
    for (const x of [0, r.width])
      for (const y of [
        Math.min(0, f.descent * v, (f.ascent - 1) * v),
        Math.max(r.height, f.ascent * v)
      ]) {
        const px = t[4] + (t[0] / u) * x + (t[2] / v) * y,
          py = t[5] + (t[1] / u) * x + (t[3] / v) * y
        ps.push([px, page.height - py])
      }
    const envelope = [
      Math.min(...ps.map((p) => p[0])),
      Math.min(...ps.map((p) => p[1])),
      Math.max(...ps.map((p) => p[0])),
      Math.max(...ps.map((p) => p[1]))
    ]
    records.push({
      r,
      index: i,
      envelope,
      rect: [t[4], page.height - t[5] - r.height, t[4] + r.width, page.height - t[5]]
    })
  }
  if (creditReference) return proveNativeCreditReference(candidate, page, context, records, rules)
  if (sectionReference) return proveNativeSectionBodyReference(candidate, page, records, rules)
  const starts = records.filter((v) => v.r.str === candidate.lines[0])
  if (starts.length !== 1) return
  const ix = records.indexOf(starts[0]),
    start = starts[0],
    em = start.r.height,
    tol = em * 0.015
  if (
    ix < 4 ||
    ix + 1 >= records.length ||
    !/(?:\bin(?: the)?|\bof)$/u.test(records[ix - 1].r.str.trim()) ||
    /[.!?:;]$/u.test(records[ix - 1].r.str.trim()) ||
    /[.!?]$/u.test(start.r.str.trim()) ||
    !/^[\p{Ll}\p{N}]/u.test(records[ix + 1].r.str)
  )
    return
  const calibration = records.slice(ix - 4, ix - 1),
    cue = records[ix - 1],
    pitch = calibration[1].rect[1] - calibration[0].rect[1]
  if (!(pitch >= em) || Math.abs(calibration[2].rect[1] - calibration[1].rect[1] - pitch) > tol)
    return
  const tail = []
  for (let n = ix; n < records.length && tail.length < 32; n++) {
    tail.push(records[n])
    if (n > ix && /[.!?]$/u.test(records[n].r.str.trim())) break
  }
  if (
    tail.length < 2 ||
    !/[.!?]$/u.test(tail.at(-1).r.str.trim()) ||
    candidate.lines.length > tail.length ||
    candidate.lines.some((s, n) => s !== tail[n].r.str)
  )
    return
  const owned = [...calibration, cue, ...tail],
    font = start.r.fontName
  for (let n = 0; n < owned.length; n++) {
    const z = owned[n],
      r = z.r,
      t = r.transform,
      b = z.rect
    if (
      r.fontName !== font ||
      r.str.length < 25 ||
      t[0] <= 0 ||
      t[1] !== 0 ||
      t[2] !== 0 ||
      t[3] !== em ||
      r.height !== em ||
      (n < owned.length - 1 && !r.hasEOL) ||
      (n && Math.abs(b[1] - owned[n - 1].rect[1] - pitch) > tol) ||
      b[0] < start.rect[0] - em * 0.05 ||
      b[0] > start.rect[0] + em * 2 ||
      b[0] < 0 ||
      b[1] < 0 ||
      b[2] > page.width ||
      b[3] > page.height
    )
      return
    const rows = page.lines.filter(
      (l) =>
        l.text === r.str &&
        Math.abs(l.x - b[0]) < 1e-6 &&
        Math.abs(l.y - b[1]) < 1e-6 &&
        Math.abs(l.x + l.width - b[2]) < 1e-6 &&
        Math.abs(l.y + l.height - b[3]) < 1e-6 &&
        l.fontSize === em
    )
    if (rows.length !== 1) return
  }
  if (
    candidate.rect[0] !== start.rect[0] ||
    Math.abs(candidate.rect[1] - start.rect[1]) > tol ||
    Math.abs(
      candidate.rect[2] - Math.max(...tail.slice(0, candidate.lines.length).map((z) => z.rect[2]))
    ) > 1e-6 ||
    Math.abs(candidate.rect[3] - tail[candidate.lines.length - 1].rect[3]) > tol
  )
    return
  const box = [
    Math.min(...owned.map((z) => z.rect[0])),
    owned[0].rect[1],
    Math.max(...owned.map((z) => z.rect[2])),
    owned.at(-1).rect[3]
  ]
  if (records.some((z) => !owned.includes(z) && hit(z.envelope, box))) return
  const lines = page.lines.filter(
    (l) => l.text?.trim() && hit([l.x, l.y, l.x + l.width, l.y + l.height], box)
  )
  if (lines.length !== owned.length) return
  if (
    rules.some(
      (r) =>
        !finite(r, 4) ||
        hit(
          [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])],
          box
        )
    )
  )
    return
  if (
    page.graphicsBounds.some(
      (g) =>
        !finite(g.normalizedRect, 4) ||
        hit(
          g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
          box
        )
    )
  )
    return
  return true
}

// A coordinated reference beneath a native section title is ordinary prose only
// when the whole paragraph and independent following body cadence close its bounds.
function proveNativeSectionBodyReference(candidate, page, records, rules) {
  const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    finite = (a) => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite),
    same = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6)
  const matches = records.filter((z) => z.r.str === candidate.lines[0])
  if (matches.length !== 1) return false
  const first = matches[0],
    i = records.indexOf(first),
    em = first.r.height,
    tol = em * 0.015,
    owned = records.slice(i, i + candidate.lines.length),
    number = records[i - 2],
    title = records[i - 1],
    previous = records[i - 3],
    next = records[i + owned.length],
    calibration = records.slice(i + owned.length + 1, i + owned.length + 4)
  if (i < 3 || owned.length < 3 || owned.length > 32 || calibration.length !== 3 || !next)
    return false
  const font = first.r.fontName,
    body = (z, requireEol = true) =>
      z &&
      z.r.fontName === font &&
      z.r.height === em &&
      z.r.dir === 'ltr' &&
      z.r.transform[0] > 0 &&
      z.r.transform[1] === 0 &&
      z.r.transform[2] === 0 &&
      z.r.transform[3] === em &&
      (!requireEol || z.r.hasEOL === true) &&
      z.r.str.length >= 20 &&
      z.envelope[0] >= 0 &&
      z.envelope[1] >= 0 &&
      z.envelope[2] <= page.width &&
      z.envelope[3] <= page.height &&
      page.lines.filter(
        (l) =>
          l.text === z.r.str &&
          l.fontSize === em &&
          same([l.x, l.y, l.x + l.width, l.y + l.height], z.rect)
      ).length === 1
  if (
    !number ||
    !title ||
    !previous ||
    !/^\d+(?:\.\d+)+$/u.test(number.r.str) ||
    !/^\p{Lu}[\p{L}\p{N} -]+$/u.test(title.r.str) ||
    number.r.fontName === font ||
    number.r.fontName !== title.r.fontName ||
    number.r.height !== em ||
    title.r.height !== em ||
    Math.abs(number.rect[1] - title.rect[1]) > 1e-6 ||
    Math.abs(number.rect[0] - first.rect[0]) > tol ||
    number.rect[2] >= title.rect[0] ||
    title.rect[2] >= first.rect[2] ||
    ![number, title].every(
      (z) =>
        z.r.transform[0] === em &&
        z.r.transform[1] === 0 &&
        z.r.transform[2] === 0 &&
        z.r.transform[3] === em
    )
  )
    return false
  if (
    !body(previous, false) ||
    Math.abs(previous.rect[0] - first.rect[0]) > em * 0.05 ||
    !/[.!?]$/u.test(previous.r.str) ||
    previous.envelope[3] >= number.rect[1] ||
    title.envelope[3] >= first.rect[1] ||
    first.rect[1] - title.rect[1] > em * 2
  )
    return false
  if (
    calibration.some((z) => Math.abs(z.rect[0] - first.rect[0]) > em * 0.05) ||
    ![next, ...calibration].every((z) => body(z)) ||
    Math.abs(next.rect[0] - first.rect[0] - em) > tol ||
    !/[.!?]$/u.test(owned.at(-1).r.str)
  )
    return false
  const pitch = calibration[1].rect[1] - calibration[0].rect[1]
  if (
    pitch < em ||
    Math.abs(calibration[2].rect[1] - calibration[1].rect[1] - pitch) > tol ||
    Math.abs(calibration[0].rect[1] - next.rect[1] - pitch) > tol ||
    owned.at(-1).envelope[3] >= next.rect[1]
  )
    return false
  for (let n = 0; n < owned.length; n++) {
    const z = owned[n],
      b = z.rect
    if (
      !body(z) ||
      z.r.str !== candidate.lines[n] ||
      Math.abs(b[0] - first.rect[0]) > em * 0.05 ||
      (n && Math.abs(b[1] - owned[n - 1].rect[1] - pitch) > tol) ||
      b[0] < 0 ||
      b[1] < 0 ||
      b[2] > page.width ||
      z.envelope[3] > page.height
    )
      return false
    if (
      page.lines.filter(
        (l) =>
          l.text === z.r.str &&
          l.fontSize === em &&
          same([l.x, l.y, l.x + l.width, l.y + l.height], b)
      ).length !== 1
    )
      return false
  }
  const union = [
    Math.min(...owned.map((z) => z.rect[0])),
    first.rect[1],
    Math.max(...owned.map((z) => z.rect[2])),
    owned.at(-1).rect[3]
  ]
  if (!same(candidate.rect, union)) return false
  const selected = [number, title, ...owned],
    box = [
      union[0],
      number.rect[1],
      Math.max(title.rect[2], union[2]),
      Math.max(...owned.map((z) => z.envelope[3]))
    ]
  if (
    selected.some(
      (z) =>
        z.envelope[0] < 0 ||
        z.envelope[1] < 0 ||
        z.envelope[2] > page.width ||
        z.envelope[3] > page.height
    )
  )
    return false
  if (records.some((z) => !selected.includes(z) && hit(z.envelope, box))) return false
  const headingBox = [number.rect[0], number.rect[1], title.rect[2], title.rect[3]],
    headingLines = page.lines.filter((l) =>
      hit([l.x, l.y, l.x + l.width, l.y + l.height], headingBox)
    ),
    nativeHeading = [number, title]
  const rowMatches = (l, z) =>
    l.text === z.r.str &&
    l.fontSize === em &&
    same([l.x, l.y, l.x + l.width, l.y + l.height], z.rect)
  if (
    !(
      headingLines.length === 1 &&
      headingLines[0].text === number.r.str + ' ' + title.r.str &&
      headingLines[0].fontSize === em &&
      same(
        [
          headingLines[0].x,
          headingLines[0].y,
          headingLines[0].x + headingLines[0].width,
          headingLines[0].y + headingLines[0].height
        ],
        headingBox
      )
    ) &&
    !(
      headingLines.length === 2 &&
      nativeHeading.every((z) => headingLines.filter((l) => rowMatches(l, z)).length === 1)
    )
  )
    return false
  const bodyBox = box
  if (
    page.lines.some(
      (l) =>
        typeof l.text !== 'string' ||
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
        l.width <= 0 ||
        l.height <= 0 ||
        l.fontSize <= 0
    ) ||
    page.lines.filter(
      (l) => l.text.trim() && hit([l.x, l.y, l.x + l.width, l.y + l.height], bodyBox)
    ).length !==
      owned.length + headingLines.length
  )
    return false
  if (
    rules.some(
      (r) =>
        !finite(r) ||
        hit(
          [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])],
          box
        )
    )
  )
    return false
  if (
    page.graphicsBounds.some(
      (g) =>
        !finite(g.normalizedRect) ||
        g.normalizedRect.some((n) => n < 0 || n > 1) ||
        g.normalizedRect[2] <= g.normalizedRect[0] ||
        g.normalizedRect[3] <= g.normalizedRect[1] ||
        hit(
          g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width)),
          box
        )
    )
  )
    return false
  return true
}

// A complete native paragraph can wrap its figure reference after a row-of cue.
// This late metadata refusal requires untouched whole source items, not geometry order.
// Metadata-only: a complete native paragraph can wrap a panel citation after
// "shown in". This neither creates pixel bounds nor suppresses body Source.
function isNativeClosedPanelBodyReference(candidate, page, context, rules = []) {
  try {
    const native = context?.nativeFigureContext,
      finite = (r, n) => Array.isArray(r) && r.length === n && r.every(Number.isFinite),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6)),
      union = (rs) => [
        Math.min(...rs.map((r) => r[0])),
        Math.min(...rs.map((r) => r[1])),
        Math.max(...rs.map((r) => r[2])),
        Math.max(...rs.map((r) => r[3]))
      ]
    if (
      !candidate ||
      candidate.regions ||
      !Array.isArray(candidate.lines) ||
      candidate.lines.length < 4 ||
      candidate.lines.length > 16 ||
      !/^Fig\.\s+[1-9]\d*[a-z]\.\s+\p{Lu}/u.test(candidate.lines[0]) ||
      !/[.!?]$/u.test(candidate.lines.at(-1)) ||
      !finite(candidate.rect, 4) ||
      candidate.page !== page?.pageNumber ||
      context?.pageNumber !== page.pageNumber ||
      native?.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(native.sourceSha256 ?? '') ||
      page.rotation !== 0 ||
      page.renderRotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      !Array.isArray(page.lines) ||
      page.lines.length > 4096 ||
      !Array.isArray(page.graphicsBounds) ||
      !Array.isArray(rules) ||
      !Array.isArray(native.content?.items) ||
      !Array.isArray(context.content?.items) ||
      native.content.items.length !== context.content.items.length ||
      !finite(context.viewport?.transform, 6) ||
      context.viewport.transform.some((v, i) => v !== [1, 0, 0, -1, 0, page.height][i]) ||
      native.viewport.width !== page.width ||
      native.viewport.height !== page.height
    )
      return false
    const forwardFonts = new Map(),
      backwardFonts = new Map()
    for (let i = 0; i < native.content.items.length; i++) {
      const a = native.content.items[i],
        b = context.content.items[i]
      if (
        a.str !== b.str ||
        !native.content.styles?.[a.fontName] ||
        !context.content.styles?.[b.fontName] ||
        JSON.stringify(native.content.styles[a.fontName]) !==
          JSON.stringify(context.content.styles[b.fontName]) ||
        (forwardFonts.has(a.fontName) && forwardFonts.get(a.fontName) !== b.fontName) ||
        (backwardFonts.has(b.fontName) && backwardFonts.get(b.fontName) !== a.fontName) ||
        a.width !== b.width ||
        a.height !== b.height ||
        a.dir !== b.dir ||
        a.hasEOL !== b.hasEOL ||
        JSON.stringify(a.transform) !== JSON.stringify(b.transform) ||
        (typeof a.str === 'string' &&
          (b.sourceItem?.pageNumber !== page.pageNumber ||
            b.sourceItem.index !== i ||
            b.sourceItem.text !== a.str))
      )
        return false
      forwardFonts.set(a.fontName, b.fontName)
      backwardFonts.set(b.fontName, a.fontName)
    }
    const tokens = native.content.items
      .filter((r) => r.str?.trim())
      .map((r) => tableTextToken(r, native.viewport, 0))
    const packet = nativePageTextPacketInventory(page, tokens, native, true)
    if (!packet || packet.records.length > 4096) return false
    const target = packet.records.filter((r) => inside(candidate.rect, r.rect))
    if (target.length < 4 || target.length > 64) return false
    const first = target[0],
      last = target.at(-1),
      em = first.r.height
    if (
      !(em > 0) ||
      !/^Fig\.\s+[1-9]\d*[a-z]\.\s+\p{Lu}/u.test(first.r.str) ||
      !/[.!?]$/u.test(last.r.str) ||
      !candidate.lines[0].startsWith(first.r.str) ||
      !candidate.lines.at(-1).endsWith(last.r.str) ||
      packet.records.filter((r) => r.index >= first.index && r.index <= last.index).length !==
        target.length
    )
      return false
    const before = packet.records.filter((r) => r.index < first.index).at(-1)
    if (
      !before ||
      before.r.fontName !== first.r.fontName ||
      before.r.height !== em ||
      before.r.hasEOL !== true ||
      !/\b(?:shown|displayed|given|plotted)\s+in$/u.test(before.r.str)
    )
      return false
    const runs = groupPageLines(page).sort((a, b) => a.y - b.y || a.x - b.x),
      firstRun = runs.filter((r) => r.text.startsWith(first.r.str)),
      startIndex = firstRun.length === 1 ? runs.indexOf(firstRun[0]) : -1,
      owned = startIndex < 0 ? [] : runs.slice(startIndex, startIndex + candidate.lines.length)
    if (
      owned.length !== candidate.lines.length ||
      owned.some((r, i) => r.text !== candidate.lines[i]) ||
      owned.some((r) => Math.abs(r.fontSize - em) > em * 0.015) ||
      !owned[0].text.startsWith('Fig.')
    )
      return false
    const pitch = owned[1].y - owned[0].y
    if (
      pitch < em ||
      pitch > em * 1.5 ||
      owned.some((r, i) => i && Math.abs(r.y - owned[i - 1].y - pitch) > em * 0.02)
    )
      return false
    const prior = runs.filter((r) => r.y < owned[0].y).at(-1)
    if (
      !prior ||
      !/\b(?:shown|displayed|given|plotted)\s+in$/u.test(prior.text) ||
      Math.abs(owned[0].y - prior.y - pitch) > em * 0.02 ||
      Math.abs(prior.fontSize - em) > em * 0.015
    )
      return false
    const paragraph = [prior, ...owned]
    for (let count = 0; count < 6; count++) {
      const next = runs.filter((r) => r.y < paragraph[0].y).at(-1)
      if (
        !next ||
        Math.abs(next.fontSize - em) > em * 0.015 ||
        Math.abs(paragraph[0].y - next.y - pitch) > em * 0.02 ||
        Math.abs(next.x - paragraph[0].x) > em * 0.15 ||
        captionKind(next.text)
      )
        break
      paragraph.unshift(next)
    }
    const heading = (r) => r && /^\d+(?:\.\d+)+\s+\p{Lu}/u.test(r.text),
      previousHeading = runs.filter((r) => r.y < paragraph[0].y).at(-1),
      nextHeading = runs.find((r) => r.y > paragraph.at(-1).y)
    if (
      paragraph.length < owned.length + 2 ||
      paragraph.length > 24 ||
      !heading(previousHeading) ||
      !heading(nextHeading) ||
      paragraph[0].y - previousHeading.bottom > em * 3 ||
      nextHeading.y - paragraph.at(-1).bottom > em * 3 ||
      !runs.some(
        (r) =>
          r.y < previousHeading.y &&
          /^Figure\s+[1-9]\d*:\s+(?:\([a-z]\)\s+)?\p{L}/u.test(r.text) &&
          r.fontSize >= em * 0.7 &&
          r.fontSize <= em * 0.95
      )
    )
      return false
    const paragraphBox = union(paragraph.map((r) => [r.x, r.y, r.right, r.bottom])),
      records = packet.records.filter((r) => inside(paragraphBox, r.rect))
    if (
      records.length < target.length + 2 ||
      records.length > 64 ||
      packet.records.filter((r) => r.index >= records[0].index && r.index <= records.at(-1).index)
        .length !== records.length
    )
      return false
    const glyphs = [...new Set(records.flatMap((r) => r.part.map((p) => p.g)))]
    if (
      glyphs.some(
        (g) =>
          g.text.trim() &&
          (g.rendererSkipped || !finite(g.ink, 4) || g.ink[0] >= g.ink[2] || g.ink[1] >= g.ink[3])
      )
    )
      return false
    const envelope = union([
      ...records.map((r) => r.rect),
      ...glyphs
        .filter((g) => !g.rendererSkipped && g.ink[0] < g.ink[2] && g.ink[1] < g.ink[3])
        .map((g) => g.ink)
    ])
    if (
      !inside([0, 0, page.width, page.height], envelope) ||
      packet.records.some(
        (r) =>
          !records.includes(r) &&
          (hit(r.rect, envelope) ||
            r.part.some((p) => !p.g.rendererSkipped && hit(p.g.ink, envelope)))
      ) ||
      page.graphicsBounds.some(
        (g) =>
          !finite(g.normalizedRect, 4) ||
          hit(
            g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
            envelope
          )
      ) ||
      rules.some(
        (r) =>
          !finite(r, 4) ||
          hit(
            [
              Math.min(r[0], r[2]),
              Math.min(r[1], r[3]),
              Math.max(r[0], r[2]),
              Math.max(r[1], r[3])
            ],
            envelope
          )
      )
    )
      return false
    return true
  } catch {
    return false
  }
}

export function isNativeRowReference(candidate, page, context, rules = []) {
  if (isNativeClosedPanelBodyReference(candidate, page, context, rules)) return true
  if (isNativeWrappedBodyReference(candidate, page, context, rules)) return true
  const finite = (r, n) => Array.isArray(r) && r.length === n && r.every(Number.isFinite)
  const raw = context?.content?.items,
    m = context?.viewport?.transform
  if (
    !candidate ||
    !page ||
    candidate.regions ||
    candidate.page !== page.pageNumber ||
    context?.pageNumber !== page.pageNumber ||
    !Array.isArray(raw) ||
    !finite(m, 6) ||
    m[0] !== 1 ||
    m[1] !== 0 ||
    m[2] !== 0 ||
    m[3] !== -1 ||
    ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
    context.viewport.width !== page.width ||
    context.viewport.height !== page.height ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.graphicsBounds) ||
    !Array.isArray(page.lines) ||
    page.lines.some(
      (l) =>
        !l ||
        typeof l.text !== 'string' ||
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
        l.width < 0 ||
        l.height < 0
    ) ||
    !finite(candidate.rect, 4) ||
    !Array.isArray(candidate.lines) ||
    !/^(?:Figure|Fig\.)\s+\d+\s+using\s+\p{Ll}/u.test(candidate.lines[0] ?? '')
  )
    return false
  const rect = (r) => {
    const t = r?.transform
    if (
      !finite(t, 6) ||
      t[0] <= 0 ||
      t[1] !== 0 ||
      t[2] !== 0 ||
      t[3] !== t[0] ||
      !Number.isFinite(r.width) ||
      !Number.isFinite(r.height) ||
      r.width <= 0 ||
      r.height !== t[0] ||
      r.dir !== 'ltr'
    )
      return
    return [t[4] + m[4], m[5] - t[5] - r.height, t[4] + m[4] + r.width, m[5] - t[5]]
  }
  const keys = new Set()
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    if (!r || typeof r !== 'object') return false
    if (!('str' in r)) continue
    const s = r.sourceItem
    if (
      typeof r.str !== 'string' ||
      !s ||
      s.pageNumber !== page.pageNumber ||
      s.index !== i ||
      s.text !== r.str ||
      keys.has(s.index) ||
      ['sourceToken', 'sourceSegment', 'sourceItems', 'sourceSegments'].some(
        (k) => r[k] !== undefined
      )
    )
      return false
    if (r.str.trim()) {
      const style = context.content.styles?.[r.fontName]
      // A zero advance does not prove empty ink. Unknown or vertical font
      // metrics cannot establish that a foreign item is outside this paragraph.
      if (
        !(Number.isFinite(r.width) && r.width > 0) ||
        !(Number.isFinite(r.height) && r.height > 0) ||
        !style ||
        style.vertical !== false ||
        !Number.isFinite(style.ascent) ||
        !Number.isFinite(style.descent) ||
        style.ascent < 0 ||
        style.descent > 0
      )
        return false
    }
    keys.add(s.index)
  }
  const starts = raw.flatMap((r, i) => (r.str === candidate.lines[0] ? [i] : []))
  if (starts.length !== 1 || starts[0] < 2 || starts[0] + 1 >= raw.length) return false
  const index = starts[0],
    cue = raw[index - 1],
    start = raw[index],
    next = raw[index + 1],
    previous = raw[index - 2]
  if (
    !/\b(?:shown|demonstrated|illustrated|displayed)\s+in\s+the\s+(?:top|bottom|upper|lower)\s+row\s+of$/u.test(
      cue.str ?? ''
    ) ||
    cue.str.length < 30 ||
    !/[.!?]$/u.test(previous.str?.trim() ?? '') ||
    !cue.hasEOL ||
    !start.hasEOL ||
    !previous.hasEOL ||
    !/^\p{Lu}/u.test(next.str ?? '') ||
    next.str.length < 25 ||
    ![cue, next, previous].every((r) => r.fontName === start.fontName) ||
    !context.content.styles?.[start.fontName]
  )
    return false
  const a = rect(cue),
    b = rect(start),
    c = rect(next),
    z = rect(previous),
    em = start.height
  if (![a, b, c, z].every(Boolean)) return false
  const pitch = b[1] - a[1],
    tolerance = em * 0.015
  if (
    !(pitch >= em && pitch <= em * 1.5) ||
    Math.abs(c[1] - b[1] - pitch) > tolerance ||
    !(a[0] > b[0] && a[0] - b[0] <= em * 2) ||
    Math.abs(a[2] - b[2]) > tolerance ||
    Math.abs(c[0] - b[0]) > tolerance ||
    a[3] > b[1] ||
    b[3] > c[1] ||
    a[1] - z[1] <= pitch + tolerance ||
    z[3] > a[1] ||
    b[2] - b[0] < em * 25 ||
    candidate.rect[0] !== b[0] ||
    Math.abs(candidate.rect[1] - b[1]) > tolerance
  )
    return false
  const bound = [b[0], a[1], b[2], b[3]]
  const hit = (r) => r[0] < bound[2] && r[2] > bound[0] && r[1] < bound[3] && r[3] > bound[1]
  const matches = (line, r, box) =>
    line.text === r.str &&
    line.fontSize === em &&
    Math.abs(line.x - box[0]) < tolerance &&
    Math.abs(line.y - box[1]) < tolerance &&
    Math.abs(line.x + line.width - box[2]) < tolerance &&
    Math.abs(line.y + line.height - box[3]) < tolerance
  const lines = page.lines.filter(
    (l) =>
      typeof l.text === 'string' && l.text.trim() && hit([l.x, l.y, l.x + l.width, l.y + l.height])
  )
  if (
    lines.length !== 2 ||
    lines.filter((l) => matches(l, cue, a)).length !== 1 ||
    lines.filter((l) => matches(l, start, b)).length !== 1
  )
    return false
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    if (!r.str?.trim() || i === index || i === index - 1) continue
    const t = r.transform
    if (
      !finite(t, 6) ||
      t[1] !== 0 ||
      t[2] !== 0 ||
      t[0] <= 0 ||
      t[3] !== t[0] ||
      !Number.isFinite(r.width) ||
      !Number.isFinite(r.height) ||
      r.width < 0 ||
      r.height < 0
    )
      return false
    const style = context.content.styles[r.fontName]
    const box = [
      t[4] + m[4],
      m[5] - t[5] - Math.max(r.height, t[3], style.ascent * t[3]),
      t[4] + m[4] + r.width,
      m[5] - t[5] - style.descent * t[3]
    ]
    if (hit(box)) return false
  }
  if (
    rules.some(
      (r) =>
        !finite(r, 4) ||
        (Math.min(r[0], r[2]) < bound[2] &&
          Math.max(r[0], r[2]) > bound[0] &&
          Math.min(r[1], r[3]) <= bound[3] &&
          Math.max(r[1], r[3]) >= bound[1])
    )
  )
    return false
  if (
    page.graphicsBounds.some(
      (g) =>
        !finite(g.normalizedRect, 4) ||
        hit(g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    )
  )
    return false
  return true
}

export function nativeConditionalFigureReferenceStarts(page) {
  const runs = groupPageLines(page)
  return new Set(
    (page.captionStarts ?? []).filter((line) => {
      const matches = runs.filter(
        (r) =>
          Math.abs(r.x - line.x) < 0.01 &&
          Math.abs(r.y - line.y) < 0.01 &&
          line.x + line.width <= r.right + 0.01 &&
          r.text.replace(/\s/gu, '').startsWith(line.text.replace(/\s/gu, ''))
      )
      return matches.length === 1 && nativeConditionalFigureReference(matches[0], runs, page)
    })
  )
}

// A double-spaced caption can open a text-only page after its isolated plate.
// Calibrate its leading from two native continuation rows and stop at the
// separately spaced numbered heading; ordinary body paragraphs stay outside.
function findFollowingRasterCaptionParagraph(start, runs, page, pages) {
  const title = /^(?:Figure|Fig\.)\s+([A-Z]?\d+)\.\s+\p{Lu}/u.exec(start.text),
    prior = pages.find((p) => p.pageNumber === page.pageNumber - 1),
    em = start.fontSize,
    image = prior?.graphicsBounds?.[0]
  if (
    !title ||
    !(em > 0) ||
    start.y >= page.height * 0.12 ||
    page.rotation !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    page.graphicsBounds?.length !== 0 ||
    prior?.rotation !== 0 ||
    prior.invalidGraphicsBounds !== 0 ||
    prior.graphicsBounds.length !== 1 ||
    image.kind !== 'image' ||
    !image.imageHash ||
    !new RegExp(
      `^(?:Figure|Fig\\.)\\s+${title[1]}\\s+(?:shows?|depicts?|illustrates?)\\s+`,
      'iu'
    ).test(prior.lines[0]?.text ?? '') ||
    runs.some((r) => r !== start && r.y < start.y && r.text.trim())
  )
    return
  const rows = runs.filter((r) => r.y > start.y).sort((a, b) => a.y - b.y),
    tail = []
  let leading
  for (const r of rows.slice(0, 6)) {
    const previous = tail.at(-1) ?? start,
      gap = r.y - previous.y
    if (
      captionKind(r.text) ||
      ![r.x, r.y, r.right, r.bottom, r.fontSize].every(Number.isFinite) ||
      Math.abs(r.fontSize - em) > em * 0.02 ||
      Math.abs(r.x - start.x) > em * 0.1 ||
      r.right > page.width - start.x + em * 0.1 ||
      r.right - r.x < em * 6 ||
      gap < em * 2 ||
      gap > em * 2.4 ||
      (leading && Math.abs(gap - leading) > em * 0.1)
    )
      break
    if (!tail.length && !/^\p{Ll}/u.test(r.text)) return
    leading ??= gap
    tail.push(r)
    if (/[.!?]$/u.test(r.text.trim())) break
  }
  const heading = rows[tail.length],
    last = tail.at(-1)
  if (
    tail.length < 2 ||
    !/[.!?]$/u.test(last.text.trim()) ||
    !heading ||
    !/^\d+\.\d+\.?\s+\p{Lu}/u.test(heading.text) ||
    heading.y - last.y < leading + em * 0.5 ||
    heading.y - last.y > leading + em * 2
  )
    return
  return tail
}

export function findCaptionCandidates(pages, rulesByPage = new Map()) {
  // Table borders are often painted one segment per column. Treat subpixel
  // joints as one separator without connecting unrelated rules across gutters.
  const separators = new Map(
    [...rulesByPage].map(([page, rules]) => {
      const joined = []
      for (const r of rules
        .filter((r) => r[1] === r[3])
        .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
        const last = joined.at(-1)
        if (last && Math.abs(last[1] - r[1]) < 0.01 && r[0] <= last[2] + 0.75)
          last[2] = Math.max(last[2], r[2])
        else joined.push([...r])
      }
      return [page, joined]
    })
  )
  const candidates = []
  for (const page of pages) {
    const runs = groupPageLines(page, separators.get(page.pageNumber) ?? [])
    const ownedRuns = new Set()
    const completedCaptionRuns = new Set()
    const hasAdjacentImageAboveUnpunctuatedFigure = (line) => {
      if (
        /^Figure\s+\d+\s+The illustration of\b/i.test(line.text) ||
        !/^(?:Fig\.?|Figure)\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+)\s+\p{L}/iu.test(line.text)
      )
        return false
      const width = line.right - line.x
      return (page.graphicsBounds ?? []).some(({ kind, normalizedRect: rect }) => {
        if (kind !== 'image' || rect?.length !== 4 || !rect.every(Number.isFinite)) return false
        const [left, top, right, bottom] = rect.map(
          (value, axis) => value * (axis % 2 ? page.height : page.width)
        )
        return (
          right > left &&
          bottom > top &&
          bottom <= line.y &&
          line.y - bottom <= line.fontSize * 4 &&
          (right - left) * (bottom - top) > page.width * page.height * 0.02 &&
          Math.min(right, line.right) - Math.max(left, line.x) >= width * 0.6
        )
      })
    }
    const bodyReferenceBeforePrintedCaption = (line) => {
      const reference = line.text.match(/^(?:Fig\.?|Figure)\s+([A-Z]?\d+(?:\.\d+)*)\s+\p{L}/iu)
      if (!reference) return false
      return runs.some((later) => {
        if (
          later.y <= line.y ||
          !new RegExp(`^(?:Fig\\.?|Figure)\\s+${reference[1]}[.:]\\s+`, 'iu').test(later.text) ||
          !captionKind(later.text)
        )
          return false
        return (page.graphicsBounds ?? []).some(({ kind, normalizedRect: rect }) => {
          if (kind !== 'image' || rect?.length !== 4 || !rect.every(Number.isFinite)) return false
          const [left, top, right, bottom] = rect.map(
            (value, axis) => value * (axis % 2 ? page.height : page.width)
          )
          return (
            top >= line.bottom &&
            bottom <= later.y &&
            right > left &&
            bottom > top &&
            (right - left) * (bottom - top) > page.width * page.height * 0.02 &&
            Math.min(right, later.right) - Math.max(left, later.x) >=
              Math.min(line.right - line.x, later.right - later.x) * 0.6
          )
        })
      })
    }
    // Bare figure labels are conservative in `captionKind` because they can
    // be inline references. Re-admit them only when a non-page-sized native
    // graphic starts in the same label band, which proves a real top figure.
    const hasNearbyBareFigureGraphic = (start) =>
      /^(?:Fig\.?|Figure)\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+)\.\s*$/i.test(start.text) &&
      (page.graphicsBounds ?? []).some(({ normalizedRect: r }) => {
        const bounds = r.map((v, n) => v * (n % 2 ? page.height : page.width))
        const graphicArea = Math.max(0, bounds[2] - bounds[0]) * Math.max(0, bounds[3] - bounds[1])
        return (
          graphicArea < page.width * page.height * 0.8 &&
          graphicArea > page.width * page.height * 0.003 &&
          bounds[1] <= start.bottom + start.fontSize * 0.6 &&
          bounds[3] > start.y
        )
      })
    for (const start of runs.filter(
      (line) =>
        captionKind(line.text) ||
        isNativeIsolatedColonCaption(line, runs, page) ||
        /^Table\s+\d+\.\s*$/i.test(line.text.trim()) ||
        hasNearbyBareFigureGraphic(line) ||
        hasAdjacentImageAboveUnpunctuatedFigure(line) ||
        isNativePhotographCaption(line, runs, page, separators.get(page.pageNumber) ?? []) ||
        findNativeRasterStripCaption(line, runs, page, rulesByPage.get(page.pageNumber) ?? [])
    )) {
      if (
        nativeConditionalFigureReference(start, runs, page) ||
        nativePrintedCaptionBodyReference(start, runs, page, candidates) ||
        nativePrintedTableBodyReference(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? [],
          captionKind
        ) ||
        nativePanelReferenceContinuation(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? [],
          captionKind
        ) ||
        ownedRuns.has(start) ||
        bodyReferenceBeforePrintedCaption(start) ||
        [...completedCaptionRuns].some(
          (line) =>
            line.text === start.text &&
            Math.abs(line.x - start.x) < 0.01 &&
            Math.abs(line.y - start.y) < 0.01 &&
            Math.abs(line.right - start.right) < 0.01
        )
      )
        continue
      // Unpunctuated references can open a one-em indented body paragraph.
      // Require its tight preceding ending and two aligned continuations on a
      // page without graphics; finite verbs remain eligible in real captions.
      if (
        /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+\p{L}/u.test(start.text) &&
        page.invalidGraphicsBounds === 0 &&
        page.graphicsBounds?.length === 0
      ) {
        const em = start.fontSize,
          before = runs.filter(
            (r) =>
              r !== start &&
              /[.!?]$/.test(r.text) &&
              r.text.length > 24 &&
              Math.abs(r.fontSize - em) < em * 0.01 &&
              start.x - r.x >= em * 0.6 &&
              start.x - r.x <= em * 1.8 &&
              start.y - r.y > em &&
              start.y - r.y < em * 1.3 &&
              r.right - r.x < (start.right - r.x) * 0.7
          )
        if (before.length === 1) {
          const after = runs
            .filter(
              (r) =>
                r.y > start.y &&
                r.y - start.y < em * 2.6 &&
                Math.abs(r.x - before[0].x) < em * 0.05 &&
                Math.abs(r.fontSize - em) < em * 0.01 &&
                r.right <= start.right + em * 0.1 &&
                !captionKind(r.text)
            )
            .sort((a, b) => a.y - b.y)
          if (
            after.length === 2 &&
            after.every(
              (r, n) =>
                r.text.length > 24 &&
                r.y - (n ? after[n - 1].y : start.y) > em &&
                r.y - (n ? after[n - 1].y : start.y) < em * 1.3
            )
          )
            continue
        }
      }
      if (
        isNativeBodyReferenceContinuation(
          start,
          runs,
          page,
          separators.get(page.pageNumber) ?? [],
          rulesByPage.get(page.pageNumber) ?? []
        )
      )
        continue
      // A lowercase noun can complete the previous body row before an inline
      // numbered reference starts another sentence. Require the complete
      // surrounding native paragraph instead of rejecting unnumbered titles.
      if (
        /^figure\.\s+(?:Figure|Fig\.)\s+[A-Z]?\d+[a-z]?\s+(?:shows?|presents?|describes?|illustrates?)\b/.test(
          start.text
        )
      ) {
        const em = start.fontSize
        const aligned = runs.filter(
          (line) =>
            line !== start &&
            [line.x, line.y, line.right, line.bottom, line.fontSize, em].every(Number.isFinite) &&
            em > 0 &&
            line.right > line.x &&
            line.bottom > line.y &&
            Math.abs(line.fontSize - em) < em * 0.015 &&
            Math.abs(line.x - start.x) < em * 0.1 &&
            Math.abs(line.right - start.right) < em * 0.1
        )
        const preceding = aligned.filter(
          (line) =>
            line.text.length > 40 &&
            /\b(?:the|this|that|a|an)$/.test(line.text.trim()) &&
            start.y - line.y >= em &&
            start.y - line.y < em * 1.6 &&
            line.y + Math.min(line.bottom - line.y, em) <= start.y
        )
        const following = aligned.filter(
          (line) =>
            line.text.length > 40 &&
            !captionKind(line.text) &&
            line.y - start.y >= em &&
            line.y - start.y < em * 1.6
        )
        const previous = preceding.length === 1 ? preceding[0] : undefined,
          next = following.length === 1 ? following[0] : undefined
        if (
          previous &&
          next &&
          [page.width, page.height].every((value) => Number.isFinite(value) && value > 0) &&
          !runs.some(
            (line) =>
              line !== previous &&
              line !== start &&
              line !== next &&
              line.fontSize >= em * 0.8 &&
              line.y >= previous.y &&
              line.y <= next.y &&
              line.x < start.right &&
              line.right > start.x
          ) &&
          !(separators.get(page.pageNumber) ?? []).some(
            ([x0, y0, x1, y1]) =>
              ![x0, y0, x1, y1].every(Number.isFinite) ||
              (y0 === y1 && y0 >= previous.y && y0 <= next.y && x0 < start.right && x1 > start.x)
          ) &&
          !(page.graphicsBounds ?? []).some(({ normalizedRect: r }) => {
            if (!r || r.length !== 4 || !r.every(Number.isFinite)) return true
            const [left, top, right, bottom] = r.map(
              (v, n) => v * (n % 2 ? page.height : page.width)
            )
            if (right <= left || bottom <= top) return true
            return (
              right > start.x &&
              left < start.right &&
              top < next.bottom &&
              bottom > previous.y - em &&
              bottom - top > em * 0.5
            )
          })
        )
          continue
      }
      // A numbered box is a table only when its enclosing frame contains
      // repeated, genuinely separate text columns. A framed paragraph or
      // single-column list does not supply that evidence.
      if (/^Box\s/i.test(start.text)) {
        const frame = (page.graphicsBounds ?? [])
          .filter((g) => g.kind === 'path')
          .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)))
          .find(
            (r) =>
              r[0] <= start.x &&
              r[2] >= start.right &&
              r[1] <= start.y &&
              r[3] > start.bottom &&
              start.y - r[1] < start.fontSize * 2 &&
              r[2] - r[0] < page.width * 0.95
          )
        if (!frame) continue
        const body = page.lines.filter(
          (l) =>
            l.y >= start.bottom &&
            l.y + l.height <= frame[3] &&
            l.x >= frame[0] &&
            l.x + l.width <= frame[2]
        )
        const starts = []
        for (const l of body) {
          let g = starts.find((g) => Math.abs(g[0].x - l.x) < 1)
          if (g) g.push(l)
          else starts.push([l])
        }
        const columns = starts.filter((g) => g.length >= 3).sort((a, b) => a[0].x - b[0].x)
        if (
          columns.length !== 2 ||
          columns.flat().length < body.length * 0.8 ||
          columns[1][0].x - columns[0][0].x < page.width * 0.15 ||
          columns[0].filter((l) => l.x + l.width <= columns[1][0].x - 4).length <
            columns[0].length * 0.9
        )
          continue
      }
      // Range-qualified labels are also legitimate graphic captions. Reject
      // only a native continuation after two consecutive same-column prose
      // rows ending in a comma, with no independently adjacent visual plate.
      if (
        /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s*\([a-z]\)\s*[-–]\s*\([a-z]\)\.\s+(?:The|This|These|Those|Our|Their|It|They)\b[^.!?]{0,90}\b(?:is|are|was|were|has|have|had)\b/i.test(
          start.text
        )
      ) {
        const preceding = runs
          .filter(
            (line) =>
              line.text.length >= 40 &&
              Math.abs(line.x - start.x) < start.fontSize * 0.1 &&
              Math.abs(line.fontSize - start.fontSize) < start.fontSize * 0.03 &&
              line.bottom <= start.y &&
              start.y - line.y <= start.fontSize * 3 &&
              line.right - line.x >= (start.right - start.x) * 0.6
          )
          .sort((a, b) => a.y - b.y)
        const previous = preceding.at(-1),
          earlier = preceding.at(-2)
        const plate = (page.graphicsBounds ?? []).some((graphic) => {
          const [left, top, right, bottom] = graphic.normalizedRect.map(
            (v, axis) => v * (axis % 2 ? page.height : page.width)
          )
          if (
            graphic.kind === 'path' &&
            previous &&
            earlier &&
            [earlier, previous].every(
              (line) =>
                left <= line.x + start.fontSize * 0.1 &&
                right >= line.right - start.fontSize * 0.1 &&
                top <= line.y &&
                bottom >= line.bottom
            )
          )
            return false
          return (
            bottom <= start.y + start.fontSize * 0.2 &&
            start.y - bottom < start.fontSize * 4 &&
            bottom - top > start.fontSize * (graphic.kind === 'image' ? 0.5 : 2) &&
            right - left > page.width * 0.15 &&
            Math.min(right, start.right) - Math.max(left, start.x) > (start.right - start.x) * 0.3
          )
        })
        if (
          previous &&
          earlier &&
          /,$/.test(previous.text.trim()) &&
          start.y - previous.bottom < start.fontSize * 0.5 &&
          previous.y - earlier.y < start.fontSize * 1.6 &&
          !plate
        )
          continue
      }
      if (provesNativeBodyReference(start, runs, page, separators.get(page.pageNumber) ?? []))
        continue
      // A reference wrapped after "listed in" is part of the same paragraph.
      // Require its preceding source line, matching typography and tight leading.
      if (
        (/^(?:Table|Tab\.)\s+\d+\s+(?:for\s+[a-z]|The\s+)/.test(start.text) ||
          /^(?:(?:Supplementary|Supplemental)\s+)?(?:(?:Figure|Fig\.)\s+\d+|(?:Table|Tab\.)\s+(?:\d+|[IVXLCDM]+))[.:]\s+\p{L}/u.test(
            start.text
          )) &&
        runs.some(
          (line) =>
            (/(?:\b(?:listed|shown|provided|presented|reported|displayed|conditions) in|\b(?:shown|indicated|displayed) at the (?:top|bottom) of|\bbetween conditions,|\bin (?:Supplemental|Supplementary)|\b(?:Supplementary |Supplemental )?(?:Table|Figure|Fig\.) \d+ and)$/.test(
              line.text
            ) ||
              // A reference can end a statistical sentence and share its
              // physical line with the next sentence. Bare "in" needs tight
              // body leading, not the wider spacing allowed for explicit cues.
              (line.text.length > 40 &&
                /\bin$/.test(line.text) &&
                start.y - line.bottom <= start.fontSize * 0.5)) &&
            (Math.abs(line.x - start.x) <= 2 ||
              provesWrappedNativeColumn(
                start,
                line,
                runs,
                page,
                separators.get(page.pageNumber) ?? []
              )) &&
            Math.abs(line.fontSize - start.fontSize) <= 0.5 &&
            [
              line.x,
              line.y,
              line.right,
              line.bottom,
              line.fontSize,
              start.x,
              start.y,
              start.right,
              start.bottom,
              start.fontSize
            ].every(Number.isFinite) &&
            line.right > line.x &&
            line.bottom > line.y &&
            start.right > start.x &&
            start.bottom > start.y &&
            !(separators.get(page.pageNumber) ?? []).some(
              ([x0, y0, x1, y1]) =>
                y0 === y1 && y0 >= line.bottom && y0 <= start.y && x0 < start.right && x1 > start.x
            ) &&
            line.y + Math.min(line.bottom - line.y, line.fontSize) <= start.y &&
            start.y - line.bottom <=
              start.fontSize * (captionKind(start.text) === 'figure' ? 1.5 : 0.5)
        )
      )
        continue
      // A dotted panel pointer follows an explicit native paragraph cue.
      // This source-only refusal neither rewrites its text nor claims a plate.
      if (
        /^(?:Fig\.?|Figure)\s+\d+\.[a-z],\s+\p{L}/iu.test(start.text) &&
        runs.some(
          (line) =>
            line.text.length > 40 &&
            /\b(?:illustrated|shown|described)\s+in$/i.test(line.text.trim()) &&
            line.x > start.x &&
            line.x - start.x <= start.fontSize * 2 &&
            Math.abs(line.right - start.right) < start.fontSize * 0.2 &&
            Math.abs(line.fontSize - start.fontSize) < start.fontSize * 0.015 &&
            line.bottom <= start.y &&
            start.y - line.bottom < start.fontSize * 0.5 &&
            !(separators.get(page.pageNumber) ?? []).some(
              ([x0, y0, x1, y1]) =>
                y0 === y1 && y0 >= line.bottom && y0 <= start.y && x0 < start.right && x1 > start.x
            ) &&
            !(page.graphicsBounds ?? []).some(({ normalizedRect: rect }) => {
              const [left, top, right, bottom] = rect.map(
                (value, axis) => value * (axis % 2 ? page.height : page.width)
              )
              return (
                bottom <= start.y + start.fontSize * 0.1 &&
                start.y - bottom < start.fontSize * 1.5 &&
                bottom - top > start.fontSize * 3 &&
                Math.min(right, start.right) - Math.max(left, start.x) >
                  (start.right - start.x) * 0.6
              )
            })
        )
      )
        continue
      // A conjunction pointer or repeated finite pointer can be a tightly
      // led continuation of two complete native body rows. Require both
      // preceding rows and their preposition; the label alone proves nothing.
      const continuedPointer =
        /^(?:Figure|Fig\.)\s+[A-Z]?\d+\s+(?:or\b|\([a-z]\)\s*[-–]\s*\([a-z]\),\s+whereas\b)/i.test(
          start.text
        )
      if (
        /^(?:(?:Figure|Fig\.)\s+[A-Z]?\d+\s+(?:and|or)\b|(?:Figure|Fig\.)\s+[A-Z]?\d+\s+\([a-z]\)\s*[-–]\s*\([a-z]\),\s+whereas\b|((?:Figure|Fig\.)\s+[A-Z]?\d+)\.\s+\1\s+(?:shows?|presents?|describes?|illustrates?)\b)/i.test(
          start.text
        )
      ) {
        const preceding = runs
          .filter(
            (line) =>
              line.text.length > 40 &&
              Math.abs(line.fontSize - start.fontSize) < start.fontSize * 0.015 &&
              line.bottom <= start.y &&
              start.y - line.y < start.fontSize * 3 &&
              line.x >= start.x - start.fontSize * 0.02 &&
              line.x - start.x < start.fontSize * 2 &&
              Math.abs(line.right - start.right) < start.fontSize * 0.02 &&
              line.right - line.x > (start.right - start.x) * 0.9
          )
          .sort((a, b) => a.y - b.y)
        const previous = preceding.at(-1),
          earlier = preceding.at(-2),
          em = start.fontSize
        if (
          previous &&
          earlier &&
          /\b(?:in|of)$/i.test(previous.text.trim()) &&
          !/[.!?:]$/.test(earlier.text.trim()) &&
          Math.abs(previous.x - start.x) < em * 0.02 &&
          start.y - previous.bottom >= 0 &&
          start.y - previous.bottom < em * 0.5 &&
          previous.y - earlier.y >= em &&
          previous.y - earlier.y < em * 1.4 &&
          Math.abs(start.y - previous.y - (previous.y - earlier.y)) < em * 0.2 &&
          !(separators.get(page.pageNumber) ?? []).some(
            ([x0, y0, x1, y1]) =>
              y0 === y1 && y0 >= earlier.bottom && y0 <= start.y && x0 < start.right && x1 > start.x
          ) &&
          !(page.graphicsBounds ?? []).some(({ normalizedRect: r }) => {
            const [left, top, right, bottom] = r.map(
              (v, n) => v * (n % 2 ? page.height : page.width)
            )
            return (
              right > start.x &&
              left < start.right &&
              top < start.bottom &&
              bottom > earlier.y - (continuedPointer ? 0 : em) &&
              bottom - top > em * 0.5
            )
          })
        )
          continue
      }

      // A paragraph opener can indent the preposition that introduces a
      // serial pointer. Require that source cue rather than classifying all
      // titles containing a second figure label as prose.
      if (
        /^(?:Fig\.?|Figure)\s+[A-Z]?\d+[.:]\s+(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+(?:shows?|presents?|describes?|illustrates?)\b/i.test(
          start.text
        ) &&
        runs.some(
          (line) =>
            /\b(?:introduced|described|shown|illustrated)\s+in$/i.test(line.text.trim()) &&
            line.x >= start.x - 0.1 &&
            line.x - start.x <= start.fontSize * 2 &&
            Math.abs(line.fontSize - start.fontSize) < start.fontSize * 0.015 &&
            line.y < start.y &&
            start.y - line.y <= start.fontSize * 2
        )
      )
        continue
      // A bare reference wrapped onto the final line of a prose paragraph
      // retains that paragraph's font, leading and small indentation.
      if (
        /^(?:Fig\.?|Figure)\s+\d+(?:\s+and\s+Table\s+\d+|(?:\s+\d+)?,\s*(?:left|right|middle))?\s*\.$/i.test(
          start.text
        ) &&
        runs.some(
          (line) =>
            line.text.length > 40 &&
            !/[.!?:]$/.test(line.text) &&
            Math.abs(line.fontSize - start.fontSize) < 0.5 &&
            start.x - line.x >= -1 &&
            start.x - line.x < start.fontSize &&
            line.bottom <= start.y &&
            start.y - line.bottom < start.fontSize * 0.5
        )
      )
        continue
      // A bare table number at the end of a paragraph is an inline
      // reference, even when the PDF stream emits it as a separate line.
      // Keep standalone table numbers eligible when they have their own
      // descriptive title or native table-boundary evidence below.
      if (
        /^Table\s+\d+\s*\.$/i.test(start.text) &&
        runs.some(
          (line) =>
            line.text.length > 24 &&
            /(?:shown|reported|presented|listed|summari[sz]ed|described)\s+in$/i.test(
              line.text.trim()
            ) &&
            Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
            Math.abs(start.x - line.x) < 2 &&
            line.bottom <= start.y &&
            start.y - line.bottom < start.fontSize * 0.6
        )
      )
        continue
      // Supplementary ordinals and Roman table labels can also be split from
      // a following-page caption. A preceding prose line ending in a
      // reference preposition makes the bare label an inline pointer.
      if (
        /^(?:Figure|Fig\.?|Table|Tab\.?)\s+(?:[A-Z]?\d+(?:\.\d+)*|[A-Z][.-]\d+(?:\.\d+)*|[IVXLCDM]+)\.\s*$/i.test(
          start.text
        ) &&
        runs.some(
          (line) =>
            line.text.length > 24 &&
            /\bin$/i.test(line.text.trim()) &&
            Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
            Math.abs(line.x - start.x) < start.fontSize * 0.1 &&
            line.y + Math.min(line.bottom - line.y, line.fontSize) <= start.y &&
            start.y - line.y < start.fontSize * 1.7
        )
      )
        continue
      // A larger body paragraph can begin with a pointer to the already
      // captioned diagram. Require the same printed ordinal, one earlier
      // colon caption, a whole same-font continuation and no second carrier
      // in the intervening band; ordinary descriptive figure titles survive.
      const assumedPointer =
        /^Figure\s+([A-Z]?\d+)\.\s+The\b[^.!?]*\bis (?:assumed|taken) to be\b/u.exec(start.text)
      if (assumedPointer && page.invalidGraphicsBounds === 0) {
        const heads = runs.filter(
          (l) =>
            new RegExp(`^Figure\\s+${assumedPointer[1]}:\\s+`).test(l.text) &&
            l.bottom < start.y &&
            l.fontSize < start.fontSize * 0.95 &&
            start.y - l.bottom < start.fontSize * 4
        )
        const head = heads[0],
          continuations = runs.filter(
            (l) =>
              l !== start &&
              l.y > start.y &&
              l.y - start.y < start.fontSize * 1.6 &&
              Math.abs(l.x - start.x) < 0.1 &&
              Math.abs(l.fontSize - start.fontSize) < start.fontSize * 0.01 &&
              /^[a-z]/u.test(l.text)
          ),
          boxes = (page.graphicsBounds ?? []).map((g) =>
            g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
          )
        if (
          heads.length === 1 &&
          continuations.length === 1 &&
          boxes.length &&
          boxes.every((r) => r.length === 4 && r.every(Number.isFinite)) &&
          boxes.some(
            (r) =>
              r[3] <= head.y &&
              head.y - r[3] < start.fontSize * 4 &&
              r[2] - r[0] > start.fontSize * 8 &&
              r[3] - r[1] > start.fontSize * 4
          ) &&
          !boxes.some((r) => r[1] < continuations[0].bottom && r[3] > head.bottom)
        )
          continue
      }
      const singleSpacedParagraph = findNativeSingleSpacedCaptionParagraph(
        start,
        runs,
        page,
        rulesByPage.get(page.pageNumber) ?? []
      )
      const panelParagraph =
        findNativeDirectionalPanelCaptionParagraph(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? []
        ) ?? findNativePanelCaptionParagraph(start, runs, page)
      const boundedParagraph = panelParagraph
        ? undefined
        : findNativeBoundedFigureParagraph(
            start,
            runs,
            page,
            rulesByPage.get(page.pageNumber) ?? []
          )
      const internalReferenceParagraph = findNativeInternalReferenceParagraph(
        start,
        runs,
        page,
        rulesByPage.get(page.pageNumber) ?? []
      )
      let nativeParagraph =
        findFollowingRasterCaptionParagraph(start, runs, page, pages) ??
        findNativeRasterStripCaption(start, runs, page, rulesByPage.get(page.pageNumber) ?? []) ??
        findNativeCenteredRuledTitle(start, runs, page, separators.get(page.pageNumber) ?? []) ??
        findNativeUnpunctuatedRasterCaption(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? []
        ) ??
        findNativeSmallerFigureCaption(start, runs, page) ??
        findNativeMixedLabelCaptionParagraph(start, runs, page) ??
        internalReferenceParagraph ??
        panelParagraph ??
        singleSpacedParagraph ??
        boundedParagraph?.tail ??
        findNativeShortCenteredCaption(start, runs, page, rulesByPage.get(page.pageNumber) ?? []) ??
        findNativeCenteredFigureParagraph(start, runs, page) ??
        findNativeCenteredVectorCaptionTail(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? []
        ) ??
        findNativeMathCaptionParagraph(start, runs, page, separators.get(page.pageNumber) ?? []) ??
        findNativeHangingCaptionBeforeSection(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? []
        ) ??
        findNativeIndentedRasterCaption(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? []
        ) ??
        findNativeClosedOutdentedFigureCaption(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? []
        ) ??
        findNativeCaptionParagraph(start, runs, page, separators.get(page.pageNumber) ?? []) ??
        findNativeUniformBaselineCaption(
          start,
          runs,
          page,
          separators.get(page.pageNumber) ?? []
        ) ??
        findNativeMixedLegend(start, page) ??
        findNativeTwoThirdFigureCaption(start, runs, page) ??
        findIndependentSpacedCaption(start, runs, page, separators.get(page.pageNumber) ?? [])
      // A wrapped numbered reference is an interior caption row only when
      // the complete single-spaced proof survives. Keep the ordinary generic
      // paragraph fallbacks from reattaching that row after a proof mutation.
      const referenceRow = runs.find((line) => {
        if (!/\b(?:in|from)$/iu.test(start.text.trim())) return false
        if (
          !/^(?:Fig\.?|Figure|Tab\.?|Table)\s+[A-Z]?\d+(?:\.\d+)*(?:[.:]|\s+with\b)/iu.test(
            line.text
          ) ||
          line === start ||
          line.y <= start.y
        )
          return false
        const previous = runs
          .filter(
            (candidate) => candidate !== line && candidate.y < line.y && candidate.y >= start.y
          )
          .sort((a, b) => b.y - a.y)[0]
        return /\b(?:and|by|for|from|in|of|to|with)$/iu.test(previous?.text.trim() ?? '')
      })
      const referenceRows = referenceRow && [
        start,
        ...runs.filter((line) => line.y > start.y && line.y <= referenceRow.y)
      ]
      const referenceBottom =
        referenceRows?.reduce((bottom, line) => Math.max(bottom, line.bottom), 0) ?? 0
      const referenceAfter = referenceRow && runs.find((line) => line.y > referenceBottom + 0.02)
      const referenceGraphicOverlap =
        referenceRow &&
        (page.graphicsBounds ?? []).some((graphic) => {
          const rect = graphic?.normalizedRect
          if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return true
          const [x0, y0, x1, y1] = rect.map(
            (value, index) => value * (index % 2 ? page.height : page.width)
          )
          return x0 < start.right && x1 > start.x && y0 < referenceBottom && y1 > start.y
        })
      const anyNumberedReferenceRow = runs.find(
        (line) =>
          line !== start &&
          line.y > start.y &&
          /^(?:Fig\.?|Figure|Tab\.?|Table)\s+[A-Z]?\d+(?:\.\d+)*[.:]/iu.test(line.text)
      )
      // A later independent caption cannot make its intervening body rules
      // invalidate an already closed local paragraph. An actual interior
      // reference keeps its own complete boundary and all previous guards.
      const referenceBoundary =
        referenceRow?.bottom ??
        (nativeParagraph?.length && /[.!?]$/u.test(nativeParagraph.at(-1).text.trim())
          ? Math.max(start.bottom, ...nativeParagraph.map((line) => line.bottom))
          : (anyNumberedReferenceRow?.bottom ?? start.bottom))
      const referenceRulesBroken = (rulesByPage.get(page.pageNumber) ?? []).some(
        (rule) =>
          !Array.isArray(rule) ||
          rule.length !== 4 ||
          !rule.every(Number.isFinite) ||
          (rule[1] >= start.y &&
            rule[1] <= referenceBoundary &&
            rule[0] < start.right &&
            rule[2] > start.x)
      )
      const referenceNativeBroken =
        referenceRow &&
        (!Number.isFinite(referenceRow.right - referenceRow.x) ||
          referenceRow.right <= referenceRow.x ||
          !Number.isFinite(referenceRow.bottom - referenceRow.y) ||
          referenceRow.bottom <= referenceRow.y ||
          Math.abs(referenceRow.fontSize - start.fontSize) > start.fontSize * 0.015 ||
          start.bottom - start.y < start.fontSize - 0.02 ||
          !referenceRows
            ?.at(-2)
            ?.text.trim()
            .match(/\b(?:and|by|for|from|in|of|to|with)$/iu) ||
          referenceRulesBroken ||
          referenceGraphicOverlap ||
          !referenceAfter ||
          referenceAfter.y - referenceBottom < start.fontSize * 1.5 ||
          referenceAfter.fontSize < start.fontSize * 1.1 ||
          !(page.graphicsBounds ?? []).length)
      if (
        ((referenceRow && (!singleSpacedParagraph || referenceNativeBroken)) ||
          (anyNumberedReferenceRow && referenceRulesBroken)) &&
        !internalReferenceParagraph
      ) {
        nativeParagraph = undefined
        if (referenceRow && /\b(?:in|from)$/iu.test(start.text.trim())) {
          // A short noun tail can close a printed raster caption before a
          // distant body reference or independent neighboring caption.
          const tails = runs.filter(
            (r) =>
              r.y > start.bottom &&
              r.y - start.bottom < start.fontSize * 0.6 &&
              Math.abs(r.x - start.x) < start.fontSize * 0.1 &&
              Math.abs(r.fontSize - start.fontSize) < start.fontSize * 0.01 &&
              /^[\p{Lu}][\p{L} -]{1,40}$/u.test(r.text.trim()) &&
              r.right - r.x < (start.right - start.x) * 0.4
          )
          const tail = tails.length === 1 ? tails[0] : undefined
          const attached =
            tail &&
            /^(?:Figure|Fig\.?)\s+\d+[.:]\s/u.test(start.text) &&
            (page.graphicsBounds ?? []).some((g) => {
              if (g.kind !== 'image' || !g.normalizedRect?.every(Number.isFinite)) return false
              const [left, top, right, bottom] = g.normalizedRect.map(
                (v, n) => v * (n % 2 ? page.height : page.width)
              )
              return (
                bottom > top &&
                right > left &&
                Math.abs(start.y - bottom) < start.fontSize * 2 &&
                Math.min(right, start.right) - Math.max(left, start.x) >
                  (start.right - start.x) * 0.8
              )
            }) &&
            !runs.some(
              (r) =>
                r !== start &&
                r !== tail &&
                r.y >= start.y &&
                r.y < tail.bottom + start.fontSize * 1.5 &&
                r.x < start.right &&
                r.right > start.x
            )
          if (!attached) continue
          nativeParagraph = [tail]
        }
      }
      const lines = [boundedParagraph?.first ?? start, ...(nativeParagraph ?? [])]
      // Some table titles wrap a hyphenated word onto a short hanging line.
      // Keep it only when the native table header is separated by a painted
      // top rule, so an unrelated following paragraph cannot complete it.
      if (
        captionKind(start.text) === 'table' &&
        /\p{L}[-\u2010\u2011]$/u.test(start.text.trim()) &&
        lines.length === 1
      ) {
        const tails = runs.filter(
          (line) =>
            line.y > start.y + 2 &&
            line.y - start.y <= start.fontSize * 1.6 &&
            line.x - start.x >= start.fontSize * 2 &&
            line.x - start.x <= start.fontSize * 3 &&
            line.right <= start.right + start.fontSize * 0.2 &&
            /^[\p{Ll}][\p{L}\s-]{2,80}$/u.test(line.text.trim()) &&
            Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
            !captionKind(line.text)
        )
        if (tails.length === 1) {
          const tail = tails[0]
          const header = runs.find(
            (line) =>
              line.y > tail.bottom + start.fontSize &&
              line.y - tail.bottom <= start.fontSize * 3 &&
              /^\p{Lu}[\p{L}\s-]{5,}$/u.test(line.text.trim()) &&
              Math.abs(line.fontSize - start.fontSize) <= 0.7
          )
          const topRule = (page.graphicsBounds ?? []).some(({ kind, normalizedRect: rect }) => {
            if (kind !== 'path' || rect?.length !== 4 || !rect.every(Number.isFinite)) return false
            const [left, top, right, bottom] = rect.map(
              (value, axis) => value * (axis % 2 ? page.height : page.width)
            )
            return (
              right - left >= start.fontSize * 8 &&
              bottom - top <= start.fontSize * 0.75 &&
              top >= tail.bottom &&
              top < (header?.y ?? Infinity) &&
              left <= start.right &&
              right >= start.x &&
              left <= tail.x &&
              right >= tail.right &&
              left <= header?.x &&
              right >= (header?.right ?? -Infinity)
            )
          })
          if (header && topRule) lines.push(tail)
        }
      }
      // IEEE-style tables often emit an all-caps Roman label as one run and
      // the centered all-caps title as one or more following runs. Keep the
      // title with the label so table ownership and unstructured text retain
      // the visible description. Lowercase body lines and column headers stop
      // the bounded title scan.
      if (/^TABLE\s+[IVXLCDM]+\.?\s*$/u.test(start.text.trim())) {
        let previous = start
        const title = []
        const startCenter = (start.x + start.right) / 2
        for (const line of runs
          .filter(
            (line) =>
              line.y > start.bottom &&
              Math.abs((line.x + line.right) / 2 - startCenter) <= start.fontSize * 3
          )
          .sort((a, b) => a.y - b.y)) {
          if (line.y - previous.bottom > start.fontSize * 1.6) break
          if (
            line.text.length < 12 ||
            !/\p{Lu}/u.test(line.text) ||
            /\p{Ll}/u.test(line.text) ||
            Math.abs((line.x + line.right) / 2 - startCenter) > start.fontSize * 3
          )
            break
          title.push(line)
          previous = line
        }
        lines.push(...title)
      }
      if (lines.length === 1)
        lines.push(
          ...(findNativeBareRomanCaptionBody(
            start,
            runs,
            page,
            separators.get(page.pageNumber) ?? []
          ) ?? [])
        )
      // A measured table edge also owns a hanging terminal caption below the
      // table. The short tail must close before a distinct body paragraph.
      if (captionKind(start.text) === 'table' && lines.length === 1 && start.text.length >= 35) {
        const edges = (separators.get(page.pageNumber) ?? []).filter(
          (r) =>
            r[2] - r[0] >= (start.right - start.x) * 0.35 &&
            Math.abs(r[0] + r[2] - start.x - start.right) <= start.fontSize * 4 &&
            ((r[1] <= start.y && start.y - r[1] <= start.fontSize * 2) ||
              (r[1] > start.bottom && r[1] - start.bottom <= start.fontSize * 8))
        )
        if (edges.length) {
          const tail = runs.filter(
            (l) =>
              l.y > start.y + 2 &&
              l.y - start.y <= start.fontSize * 5 &&
              l.x >= start.x - start.fontSize * 0.3 &&
              l.x <= start.x + start.fontSize * 5 &&
              l.right <= Math.max(start.right, ...edges.map((r) => r[2])) + 1 &&
              Math.abs(l.fontSize - start.fontSize) < 0.1 &&
              !captionKind(l.text)
          )
          const parts = []
          for (const next of tail.sort((a, b) => a.y - b.y)) {
            const previous = parts.at(-1) ?? start
            if (
              next.y - previous.y > start.fontSize * 1.6 ||
              (parts.length && Math.abs(next.x - parts[0].x) > start.fontSize * 0.1)
            )
              break
            parts.push(next)
            if (/[.!?]$/.test(next.text.trim())) break
          }
          if (
            parts.length &&
            /[.!?]$/.test(parts.at(-1).text.trim()) &&
            edges.some(
              (r) =>
                (r[1] <= start.y && parts[0].x >= start.x + start.fontSize * 2) ||
                r[1] >= parts.at(-1).bottom
            )
          )
            lines.push(...parts)
        }
      }
      // A small-caps number can precede a centered two-line description. Use
      // the joined native opening to bound both lines; a centered column label
      // below that border, a gutter or a competing font cannot extend the title.
      if (/^Table\s+\d+(?:\s*\(cont[’']d\))?$/i.test(start.text.trim())) {
        const openings = (separators.get(page.pageNumber) ?? [])
          .filter(
            (r) =>
              r[1] > start.bottom &&
              r[1] - start.bottom < start.fontSize * 4 &&
              r[2] - r[0] >= page.width * 0.5 &&
              r[0] <= start.x &&
              r[2] >= start.right
          )
          .sort((a, b) => a[1] - b[1])
        if (openings.length) {
          const opening = openings[0]
          const tail = runs
            .filter(
              (l) =>
                l.y > start.y + 2 &&
                l.bottom < opening[1] &&
                l.x >= opening[0] &&
                l.right <= opening[2]
            )
            .sort((a, b) => a.y - b.y)
          if (
            tail.length === 2 &&
            tail.every(
              (l, n) =>
                !captionKind(l.text) &&
                /\p{L}/u.test(l.text) &&
                l.text.length >= 20 &&
                Math.abs(l.fontSize - start.fontSize) < 0.5 &&
                Math.abs((l.x + l.right - start.x - start.right) / 2) < start.fontSize * 0.25 &&
                l.y >= (n ? tail[n - 1].bottom : start.bottom) &&
                l.y - (n ? tail[n - 1].bottom : start.bottom) < start.fontSize
            ) &&
            opening[1] - tail.at(-1).bottom < start.fontSize * 1.2
          )
            lines.push(...tail)
        }
      }
      // A bare manuscript label can precede one complete title by double
      // leading. Require title-case words, a terminal period and a full native
      // table opening immediately below; ordinary prose or column headers do
      // not establish this detached title.
      if (/^Table\s+\d+$/i.test(start.text.trim())) {
        const title = runs.find((line) => line.y > start.bottom)
        const words = title?.text
          .replace(/\s*\(n\s*=\s*\d+\)\.?$/i, '')
          .replace(/\.$/, '')
          .split(/\s+/)
        if (
          title &&
          words.length >= 4 &&
          /\.$/.test(title.text) &&
          words.every((word) => /^(?:[A-Z][\p{L},-]*|and|of|at|in|for|the|with)$/u.test(word)) &&
          words.filter((word) => /^[A-Z]/.test(word)).length >= 3 &&
          Math.abs(title.x - start.x) <= 2 &&
          Math.abs(title.fontSize - start.fontSize) <= 0.5 &&
          title.y - start.y > start.fontSize * 1.8 &&
          title.y - start.y <= start.fontSize * 3 &&
          (separators.get(page.pageNumber) ?? []).some(
            (r) =>
              r[1] === r[3] &&
              r[1] >= title.bottom &&
              r[1] - title.bottom <= start.fontSize * 3 &&
              r[0] <= start.x + 2 &&
              r[2] >= title.right &&
              r[2] - r[0] >= page.width * 0.5
          )
        )
          lines.push(title)
      }
      const legendPage =
        captionKind(start.text) === 'figure' &&
        runs.some(
          (line) =>
            /^(?:FIGURE )?LEGENDS$/i.test(line.text.trim()) &&
            line.y < start.y &&
            Math.abs(line.x - start.x) <= 2
        )
      // A double-spaced manuscript title can end with a marked, lowercase
      // continuation just above its table border. Require the complete border
      // across both lines; alignment and extra whitespace alone are insufficient.
      if (/^Table\s*\d+[.:]\s+[\p{L}]+(?:\s+[\p{L}]+)?$/u.test(start.text)) {
        const tail = runs.find((line) => line.y > start.bottom)
        if (
          tail &&
          /^[a-z][\p{L}\s-]{7,100}[*†]$/u.test(tail.text) &&
          Math.abs(tail.x - start.x) <= 2 &&
          Math.abs(tail.fontSize - start.fontSize) <= 0.7 &&
          tail.y - start.y <= start.fontSize * 2.5
        ) {
          const borders = []
          for (const rule of (rulesByPage.get(page.pageNumber) ?? [])
            .filter(
              (r) => r[1] === r[3] && r[1] >= tail.bottom && r[1] - tail.bottom <= start.fontSize
            )
            .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
            const prior = borders.at(-1)
            if (
              prior &&
              Math.abs(prior[1] - rule[1]) < 0.01 &&
              rule[0] - prior[2] <= start.fontSize * 0.05
            )
              prior[2] = Math.max(prior[2], rule[2])
            else borders.push([...rule])
          }
          if (borders.some((r) => r[0] <= start.x + 2 && r[2] >= Math.max(start.right, tail.right)))
            lines.push(tail)
        }
      }
      const sideLegend =
        captionKind(start.text) === 'figure' &&
        (page.graphicsBounds ?? []).some(
          ({ normalizedRect: r }) =>
            (r[2] - r[0]) * (r[3] - r[1]) > 0.03 &&
            r[1] * page.height <= start.y &&
            r[3] * page.height >= start.bottom &&
            ((r[2] * page.width <= start.x && start.x - r[2] * page.width < 60) ||
              (r[0] * page.width >= start.right && r[0] * page.width - start.right < 60))
        )
      // Hanging legends align their continuation with the title after the figure
      // number. Require two adjacent prose lines, or a closed lowercase tail
      // beside a graphic when the first caption line is unfinished.
      const hangingTableTitle =
        captionKind(start.text) === 'table' && /\b(?:of|with|for|and)$/i.test(start.text)
      const outdented =
        captionKind(start.text) === 'figure' &&
        (findOutdentedParagraphContinuation(start, runs) ??
          // A broken native hyphenated word can continue at the paragraph
          // edge instead of the indented first-line edge. Require a complete
          // lowercase tail and the independently painted panel above it.
          (/[\p{L}\d]-$/u.test(start.text.trim()) &&
            runs.find(
              (l) =>
                l.y > start.y + 2 &&
                l.y - start.y < start.fontSize * 1.6 &&
                start.x - l.x > start.fontSize * 1.8 &&
                start.x - l.x < start.fontSize * 2.5 &&
                Math.abs(l.fontSize - start.fontSize) < 0.1 &&
                /^[a-z].*[.!?]$/.test(l.text) &&
                l.right <= start.right + 0.1 &&
                provesFragmentedCaptionGraphic({ ...start, x: l.x }, runs, page, l)
            )))
      const hanging =
        (captionKind(start.text) === 'figure' || hangingTableTitle) &&
        runs.find(
          (line) =>
            line.y > start.y + 2 &&
            line.y - start.y <= start.fontSize * 1.6 &&
            line.x - start.x >= start.fontSize * 2 &&
            line.x - start.x <= start.fontSize * 6 &&
            line.text.length >= (hangingTableTitle || sideLegend ? 12 : 30) &&
            Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
            !captionKind(line.text) &&
            ((hangingTableTitle && /[.)]$/.test(line.text) && line.right <= start.right + 2) ||
              (sideLegend &&
                !/[.!?]$/.test(start.text) &&
                /^[a-z].*\.$/.test(line.text) &&
                line.right <= start.right + 2) ||
              runs.some(
                (next) =>
                  next.y > line.y + 2 &&
                  next.y - line.y <= start.fontSize * 1.6 &&
                  Math.abs(next.x - line.x) <= 2 &&
                  next.text.length >= 25 &&
                  Math.abs(next.fontSize - start.fontSize) <= 0.7 &&
                  !captionKind(next.text)
              ))
        )
      // Some journals place the descriptive title in a separate full-width
      // ruled strip below an italic table number. Do not mistake that strip
      // for a header or bridge a rule on an ordinary, already complete caption.
      if (/^Table\s+\d+$/i.test(start.text.trim())) {
        const borders = (rulesByPage.get(page.pageNumber) ?? [])
          .filter((r) => r[1] === r[3] && Math.abs(r[0] - start.x) <= 2 && r[1] >= start.bottom)
          .sort((a, b) => a[1] - b[1])
        const [upper, lower] = borders
        if (
          upper &&
          lower &&
          upper[1] - start.bottom <= start.fontSize &&
          lower[1] - upper[1] <= start.fontSize * 4.5 &&
          Math.abs(upper[2] - lower[2]) <= 2
        ) {
          const strip = runs.filter(
            (line) =>
              line.y >= upper[1] &&
              line.bottom <= lower[1] &&
              line.x >= upper[0] - 2 &&
              line.right <= upper[2] + 2
          )
          if (
            strip.length >= 1 &&
            strip.length <= 3 &&
            strip[0].text.length >= 20 &&
            /\.$/.test(strip.at(-1).text) &&
            strip.every(
              (line, index) =>
                Math.abs(line.x - start.x) <= 2 &&
                Math.abs(line.fontSize - strip[0].fontSize) <= 1 &&
                !captionKind(line.text) &&
                (!index ||
                  (line.y > strip[index - 1].y &&
                    line.y - strip[index - 1].bottom <= line.fontSize))
            )
          )
            lines.push(...strip)
        }
      }
      // A standalone table number may precede a left-aligned title, with or
      // without punctuation. Require one prose block ending at the top rule.
      if (/^Table\s+\d+[.:]?$/i.test(start.text.trim())) {
        // A centered bare number may head a two-line italic title with a
        // first-line indent. The literal hyphen, shared paragraph/table center
        // and closing opening-rule gap establish both lines independently.
        const nextRows = runs
          .filter((l) => l.y > start.bottom && l.y - start.bottom < start.fontSize * 4)
          .sort((a, b) => a.y - b.y)
        const [firstTitle, finalTitle] = nextRows
        if (
          lines.length === 1 &&
          firstTitle &&
          finalTitle &&
          firstTitle.text.length >= 40 &&
          /\p{L}-$/u.test(firstTitle.text.trim()) &&
          /^[a-z].*\.$/.test(finalTitle.text.trim()) &&
          !captionKind(firstTitle.text) &&
          !captionKind(finalTitle.text) &&
          Math.abs(firstTitle.fontSize - start.fontSize) < start.fontSize * 0.02 &&
          Math.abs(finalTitle.fontSize - start.fontSize) < start.fontSize * 0.02 &&
          firstTitle.y - start.y < start.fontSize * 1.4 &&
          finalTitle.y - firstTitle.y < start.fontSize * 1.4 &&
          firstTitle.x - finalTitle.x > start.fontSize * 1.8 &&
          firstTitle.x - finalTitle.x < start.fontSize * 2.5 &&
          finalTitle.right < firstTitle.right &&
          Math.abs(finalTitle.x + firstTitle.right - start.x - start.right) <
            start.fontSize * 0.1 &&
          (separators.get(page.pageNumber) ?? []).some(
            (r) =>
              r[1] > finalTitle.bottom &&
              r[1] - finalTitle.bottom < start.fontSize * 1.8 &&
              r[2] - r[0] > page.width * 0.5 &&
              Math.abs(r[0] + r[2] - start.x - start.right) < start.fontSize * 0.1
          )
        )
          lines.push(firstTitle, finalTitle)
        const borderParts = (rulesByPage.get(page.pageNumber) ?? [])
          .filter(
            (r) =>
              r[1] === r[3] &&
              r[1] > start.bottom &&
              r[1] - start.bottom <= start.fontSize * 9 &&
              r[0] < start.x &&
              r[2] - r[0] > start.fontSize * 5
          )
          .sort((a, b) => a[1] - b[1] || a[0] - b[0])
        const joinedBorders = []
        for (const part of borderParts) {
          const previous = joinedBorders.at(-1)
          if (
            previous &&
            Math.abs(previous[1] - part[1]) <= 0.1 &&
            part[0] <= previous[2] + start.fontSize * 0.15
          )
            previous[2] = Math.max(previous[2], part[2])
          else joinedBorders.push([...part])
        }
        const border = joinedBorders.sort((a, b) => a[1] - b[1])[0]
        const rawTitle =
          border &&
          runs.filter(
            (line) =>
              line.y > start.bottom &&
              line.bottom < border[1] &&
              line.x >= border[0] - 2 &&
              line.bottom - line.y <= line.fontSize * 1.5
          )
        const title = rawTitle?.length
          ? groupPageLines({
              ...page,
              lines: rawTitle.map((line) => ({
                ...line,
                width: line.width ?? line.right - line.x,
                height: line.height ?? line.bottom - line.y
              }))
            }).filter((line) => line.y > start.bottom && line.bottom < border[1])
          : rawTitle
        if (
          lines.length === 1 &&
          title?.length &&
          title.length <= 3 &&
          title[0].text.length >= 25 &&
          title.every(
            (line, index) =>
              !captionKind(line.text) &&
              (Math.abs(line.x - title[0].x) <= 2 ||
                (index === title.length - 1 &&
                  /[\p{L}\d]-$/u.test(title[index - 1]?.text.trim() ?? '') &&
                  title[0].x - line.x > line.fontSize * 1.8 &&
                  title[0].x - line.x < line.fontSize * 2.5 &&
                  Math.abs(line.x - border[0]) < line.fontSize * 0.2 &&
                  /^[a-z].*\.$/.test(line.text.trim()) &&
                  line.right < title[0].right &&
                  title[0].right <= border[2] + line.fontSize * 0.2)) &&
              // Italic font matrices can slightly inflate fontSize while the
              // painted height still matches the surrounding upright title.
              Math.min(
                Math.abs(line.fontSize - start.fontSize),
                Math.abs(line.bottom - line.y - (start.bottom - start.y))
              ) <= 1.5 &&
              line.y - (index ? title[index - 1].bottom : start.bottom) <= start.fontSize * 1.5
          ) &&
          title[0].x < start.x &&
          title.at(-1).bottom >= border[1] - start.fontSize * 2
        ) {
          lines.push(...title)
        }
        if (lines.length === 1 && border) {
          const prose = runs.filter(
            (l) =>
              l.y > start.bottom &&
              l.bottom < border[1] &&
              l.x >= border[0] - start.fontSize &&
              l.fontSize >= start.fontSize - 0.5 &&
              l.text.length >= 25 &&
              !captionKind(l.text)
          )
          if (prose.length === 1) {
            const t = prose[0]
            const columns = runs.filter(
              (l) =>
                l.y > t.bottom &&
                l.bottom < border[1] &&
                l.x >= border[0] &&
                l.right <= border[2] + 2 &&
                l.fontSize < t.fontSize - 1.5
            )
            if (
              t.y - start.bottom <= start.fontSize * 1.5 &&
              t.x < start.x &&
              t.right - t.x > (border[2] - border[0]) * 0.5 &&
              Math.abs((start.x + start.right - border[0] - border[2]) / 2) < start.fontSize &&
              columns.length >= 3 &&
              new Set(columns.map((l) => Math.round(l.x / 30))).size >= 3
            )
              lines.push(t)
          }
        }
      }
      // Decorated table labels may be larger than a hanging descriptive title.
      // A closing sample-size line and full-width rule bound that title block.
      if (lines.length === 1 && /^Table\s+\d+\s*[&•]/.test(start.text)) {
        const border = (rulesByPage.get(page.pageNumber) ?? [])
          .filter(
            (r) =>
              r[1] === r[3] &&
              r[1] >= start.bottom &&
              r[1] - start.bottom <= start.fontSize * 4 &&
              r[0] <= start.x + 2 &&
              r[2] >= start.right - 2
          )
          .sort((a, b) => a[1] - b[1])[0]
        const tail =
          border &&
          runs.filter(
            (line) =>
              line.y > start.y + 2 &&
              line.bottom < border[1] &&
              line.x >= start.x &&
              line.right <= border[2] + 2
          )
        if (
          tail?.length &&
          tail.length <= 3 &&
          /\(N\s*=\s*\d+\)(?:, continued)?$/i.test(tail.at(-1).text) &&
          border[1] - tail.at(-1).bottom <= start.fontSize &&
          tail.every(
            (line, index) =>
              !captionKind(line.text) &&
              Math.abs(line.x - tail[0].x) <= 2 &&
              Math.abs(line.fontSize - tail[0].fontSize) <= 0.7 &&
              Math.abs(line.fontSize - start.fontSize) <= start.fontSize * 0.35 &&
              line.y - (index ? tail[index - 1].bottom : start.bottom) <= start.fontSize
          )
        )
          lines.push(...tail)
      }
      // A native opening border closes a hanging or centred title block.
      // Require uniform title type and non-overlapping lines above that border;
      // same-size column labels below it cannot extend the caption.
      if (
        lines.length === 1 &&
        captionKind(start.text) === 'table' &&
        start.text.length >= 30 &&
        !/[.!?]$/.test(start.text.trim())
      ) {
        const border = (separators.get(page.pageNumber) ?? [])
          .filter(
            (r) =>
              r[1] === r[3] &&
              r[1] > start.bottom &&
              r[1] - start.bottom < start.fontSize * 5 &&
              r[0] <= start.x + 2 &&
              r[2] >= start.right - 2
          )
          .sort((a, b) => a[1] - b[1])[0]
        const tail = border
          ? runs
              .filter(
                (l) =>
                  l.y > start.y + 2 &&
                  l.bottom <= border[1] &&
                  l.x >= border[0] - 1 &&
                  l.right <= border[2] + 1
              )
              .sort((a, b) => a.y - b.y)
          : []
        if (
          tail.length >= 1 &&
          tail.length <= 4 &&
          tail.every(
            (l, n) =>
              !captionKind(l.text) &&
              /\p{L}/u.test(l.text) &&
              Math.abs(l.fontSize - start.fontSize) < 0.5 &&
              l.y >= (n ? tail[n - 1].bottom : start.bottom) - 0.5 &&
              l.y - (n ? tail[n - 1].bottom : start.bottom) < start.fontSize &&
              (Math.abs(l.x + l.right - start.x - start.right) < start.fontSize * 2 ||
                (l.x >= start.x && l.right <= start.right))
          ) &&
          border[1] - tail.at(-1).bottom < start.fontSize
        )
          lines.push(...tail)
      }
      // ponytail: left alignment, font size and line gap cannot distinguish a caption from body text.
      for (let count = 1; !nativeParagraph && count < runs.length; count++) {
        const previous = lines.at(-1)
        const scannedTitle = (line) =>
          (lines.length === 1 || /\b(?:of|and|the)$/i.test(previous.text)) &&
          /^Table\s+\d+$/i.test(start.text.trim()) &&
          line.text.length >= 15 &&
          !/\d/.test(line.text) &&
          line.fontSize < start.fontSize &&
          Math.abs((line.x + line.right - start.x - start.right) / 2) <= 2 &&
          (page.graphicsBounds ?? []).some(
            (g) =>
              g.kind === 'image' &&
              (g.normalizedRect[2] - g.normalizedRect[0]) *
                (g.normalizedRect[3] - g.normalizedRect[1]) >
                0.9
          )
        const participantLine = (line) =>
          lines.length === 1 &&
          /^Table\s+\d+\s*[&•]/.test(start.text) &&
          /^(?:Participants?|Patients?)\s*\(N\s*=\s*\d+\)(?:, continued)?$/i.test(line.text) &&
          line.x >= start.x &&
          line.right <= start.right + start.fontSize * 2
        const centeredFigureTail = (line) =>
          captionKind(start.text) === 'figure' &&
          (!/[.!?]$/.test(previous.text.trim()) ||
            (/\bLeft:\s/.test(start.text) &&
              /\bMiddle:\s/.test(start.text) &&
              /^Right:\s+\p{L}[^.!?]{5,70}\.$/u.test(line.text.trim()))) &&
          previous.right - previous.x >= page.width * 0.35 &&
          (/^[a-z].*[.!?]$/.test(line.text.trim()) ||
            /^[a-z][\p{L}\s-]{4,60}$/u.test(line.text.trim()) ||
            /^Right:\s+\p{L}[^.!?]{5,70}\.$/u.test(line.text.trim())) &&
          line.right - line.x < (start.right - start.x) * 0.8 &&
          Math.abs((line.x + line.right - start.x - start.right) / 2) <= 2 &&
          Math.abs(line.fontSize - start.fontSize) <= 0.1 &&
          line.y - previous.y <= start.fontSize * 1.6 &&
          !runs.some(
            (other) =>
              other !== line &&
              other.y > previous.bottom &&
              other.y < line.bottom &&
              other.x >= start.x &&
              other.right <= start.right
          ) &&
          ((/\bLeft:\s/.test(start.text) &&
            /\bMiddle:\s/.test(start.text) &&
            /^Right:\s/.test(line.text)) ||
            (page.graphicsBounds ?? []).some(
              (g) =>
                g.kind === 'image' &&
                g.normalizedRect[0] * page.width >= start.x - start.fontSize &&
                g.normalizedRect[2] * page.width <= start.right + start.fontSize &&
                g.normalizedRect[3] * page.height <= start.y + page.height / 256 &&
                start.y - g.normalizedRect[3] * page.height < start.fontSize * 3
            ))
        // Background boxes around several literal words can slightly inset
        // the final prose row. Require an unfinished caption and independent
        // native boxes on this row, rather than accepting indentation alone.
        const boxedTableTail = (line) => {
          if (
            captionKind(start.text) !== 'table' ||
            lines.length < 2 ||
            !/\bin$/i.test(previous.text.trim()) ||
            !/[.!?]$/.test(line.text.trim()) ||
            line.text.length < 15 ||
            line.text.length > 100 ||
            line.x < start.x ||
            line.x - start.x > start.fontSize * 0.8 ||
            line.right > Math.max(...lines.map((l) => l.right)) ||
            Math.abs(line.fontSize - start.fontSize) > start.fontSize * 0.01 ||
            line.y - previous.y > start.fontSize * 1.6
          )
            return false
          const boxes = (page.graphicsBounds ?? [])
            .filter((g) => g.kind === 'path')
            .map((g) => [
              g.normalizedRect[0] * page.width,
              g.normalizedRect[1] * page.height,
              g.normalizedRect[2] * page.width,
              g.normalizedRect[3] * page.height
            ])
            .filter(
              (r) =>
                r[0] >= line.x - start.fontSize &&
                r[2] <= line.right + start.fontSize &&
                r[2] - r[0] >= start.fontSize &&
                r[2] - r[0] <= start.fontSize * 8 &&
                r[1] <= line.y &&
                r[3] >= line.bottom &&
                r[3] - r[1] <= start.fontSize * 3
            )
            .sort((a, b) => a[0] - b[0])
          return boxes.length >= 2 && boxes.some((r, i) => i && r[0] > boxes[i - 1][2])
        }
        const next = runs
          .filter(
            (line) =>
              line.y > previous.y + 2 &&
              (Math.abs(line.x - start.x) <= 2 ||
                (hanging && Math.abs(line.x - hanging.x) <= 2) ||
                (outdented && Math.abs(line.x - outdented.x) <= 2) ||
                centeredFigureTail(line) ||
                boxedTableTail(line) ||
                scannedTitle(line) ||
                participantLine(line) ||
                // Short centered continuation lines need a nearby table-header rule.
                // Alignment alone could otherwise absorb a centered column heading.
                (captionKind(start.text) === 'table' &&
                  Math.abs((line.x + line.right - start.x - start.right) / 2) <= start.fontSize &&
                  (rulesByPage.get(page.pageNumber) ?? []).some(
                    ([x0, y0, x1, y1]) =>
                      y0 === y1 &&
                      y0 >= line.bottom &&
                      y0 - line.bottom <= start.fontSize * 1.2 &&
                      x0 <= Math.min(start.x, line.x) + 2 &&
                      x1 >= line.right - 2 &&
                      x1 - x0 >= (start.right - start.x) * 0.7
                  )))
          )
          .sort((a, b) => a.y - b.y)[0]
        if (
          nativeWrappedCaptionReference(
            page,
            start,
            lines,
            runs,
            next,
            rulesByPage.get(page.pageNumber) ?? []
          )
        ) {
          lines.push(next)
          ownedRuns.add(next)
          break
        }
        const terminalReference =
          next &&
          captionKind(start.text) === 'figure' &&
          /\b(?:in|see|of|with|to)$/i.test(previous.text.trim()) &&
          /^(?:Table|Tab\.?|Figure|Fig\.?)\s+(?:[A-Z]\.)?\d+(?:\.\d+)*\.?$/i.test(
            next.text.trim()
          ) &&
          Math.abs(next.x - start.x) <= 2 &&
          Math.abs(next.fontSize - start.fontSize) <= 0.1 &&
          next.y - previous.y <= start.fontSize * 1.6
        if (terminalReference) {
          lines.push(next)
          ownedRuns.add(next)
          break
        }
        // An unfinished caption can refer to another numbered figure and
        // continue on the same physical baseline sequence. Keep that literal
        // reference with its owner only when no new plate separates the rows.
        // A caption may finish a row-of reference with two table ordinals.
        // Require the complete short terminal row and untouched native rows;
        // a separate table title or an open-ended paragraph is not evidence.
        const coordinatedTableReference =
          next &&
          /\brows\s+of$/iu.test(previous.text.trim()) &&
          /^Table\s+\d+(?:\.\d+)*\s+and\s+Table\s+\d+(?:\.\d+)*\.\s+\p{Lu}/u.test(next.text) &&
          page.invalidGraphicsBounds === 0 &&
          Array.isArray(page.graphicsBounds) &&
          (() => {
            const pitch = previous.y - lines.at(-2)?.y
            const tail = runs
              .filter((row) => row.y > next.y && row.x < start.right && row.right > start.x)
              .sort((a, b) => a.y - b.y)[0]
            if (
              !tail ||
              !/^[a-z].*[.!?]$/u.test(tail.text.trim()) ||
              tail.right - tail.x >= (start.right - start.x) * 0.8 ||
              pitch < start.fontSize ||
              pitch > start.fontSize * 1.6 ||
              Math.abs(tail.y - next.y - pitch) > start.fontSize * 0.1 ||
              Math.abs(tail.x - start.x) > start.fontSize * 0.1 ||
              Math.abs(tail.fontSize - start.fontSize) > start.fontSize * 0.015
            )
              return false
            const selected = [...lines, next, tail]
            if (
              selected.some(
                (row) =>
                  page.lines.filter(
                    (native) =>
                      native.text === row.text &&
                      native.x === row.x &&
                      native.y === row.y &&
                      native.x + native.width === row.right &&
                      native.y + native.height === row.bottom &&
                      native.fontSize === row.fontSize
                  ).length !== 1
              ) ||
              page.graphicsBounds.some((graphic) => {
                const r = graphic.normalizedRect
                if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) return true
                const box = r.map((v, axis) => v * (axis % 2 ? page.height : page.width))
                return (
                  box[0] < start.right &&
                  box[2] > start.x &&
                  box[1] < tail.bottom &&
                  box[3] > previous.bottom
                )
              })
            )
              return false
            return !(rulesByPage.get(page.pageNumber) ?? []).some(
              (r) =>
                r[0] < start.right &&
                r[2] > start.x &&
                Math.max(r[1], r[3]) > previous.bottom &&
                Math.min(r[1], r[3]) < tail.bottom
            )
          })()
        const internalReference =
          next &&
          lines.length >= 3 &&
          captionKind(start.text) === 'figure' &&
          ((/\b(?:discussed|shown|described|reported|illustrated|explained)(?:\s+further)?\s+in$/i.test(
            previous.text.trim()
          ) &&
            /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*[.:]\s+\p{L}/u.test(next.text)) ||
            coordinatedTableReference) &&
          Math.abs(next.x - start.x) < start.fontSize * 0.1 &&
          Math.abs(next.fontSize - start.fontSize) < start.fontSize * 0.015 &&
          Math.abs(next.y - previous.y - (previous.y - lines.at(-2).y)) < start.fontSize * 0.1 &&
          (provesSingleCaptionRaster(start, runs, page) ||
            provesFragmentedCaptionGraphic(start, runs, page, next, 1.2)) &&
          !(page.graphicsBounds ?? []).some((graphic) => {
            const [left, top, right, bottom] = graphic.normalizedRect.map(
              (v, axis) => v * (axis % 2 ? page.height : page.width)
            )
            return (
              top >= previous.bottom - start.fontSize * 0.1 &&
              bottom <= next.y + start.fontSize * 0.1 &&
              bottom - top >= start.fontSize * 0.3 &&
              right - left > start.fontSize * 3 &&
              left < next.right &&
              right > next.x
            )
          })
        const boundedTableTail =
          next &&
          /^Table\s+\d+\s*[.:]\s*\S.{15}/i.test(start.text) &&
          !/[.!?]$/.test(previous.text.trim()) &&
          !/^Tabelle\s+\d+/i.test(next.text) &&
          (next.text.length >= 20 ||
            // A single-word tail in a double-spaced title still needs an
            // opening table rule; an ordinary short heading is insufficient.
            (/^[A-Za-z]{4,}(?:[ .-][A-Za-z]+)*$/.test(next.text.trim()) &&
              previous.text.length >= 60 &&
              (separators.get(page.pageNumber) ?? []).some(
                (r) =>
                  r[1] === r[3] &&
                  r[1] >= next.bottom &&
                  r[1] - next.bottom <= start.fontSize * 3.5 &&
                  r[0] <= start.x + 2 &&
                  r[2] >= next.right
              ))) &&
          (Math.abs(next.x - start.x) <= 2 ||
            Math.abs((next.x + next.right - start.x - start.right) / 2) <= start.fontSize) &&
          (separators.get(page.pageNumber) ?? []).some(
            (r) =>
              r[1] === r[3] &&
              r[1] >= next.bottom &&
              r[1] - start.bottom <= start.fontSize * 16 &&
              r[0] <= start.x + 8 &&
              r[2] - r[0] >= page.width * 0.5
          )
        const centeredTitle =
          next &&
          (scannedTitle(next) ||
            (/^Table\s+\d+$/i.test(start.text.trim()) &&
              Math.abs((next.x + next.right - start.x - start.right) / 2) <= 2 &&
              (rulesByPage.get(page.pageNumber) ?? []).some(
                (r) =>
                  r[1] === r[3] &&
                  r[1] >= next.bottom &&
                  r[1] - next.bottom <= start.fontSize * 2 &&
                  r[0] <= next.x &&
                  r[2] >= next.right
              )))
        const spacedFigureTail =
          next &&
          captionKind(start.text) === 'figure' &&
          Math.abs(next.x - start.x) <= 2 &&
          /^[a-z]/.test(next.text) &&
          (/\b(?:in|and|of|the|with|by)$/i.test(previous.text) ||
            (lines.length > 1 &&
              Math.abs(next.y - previous.y - previous.y + lines.at(-2).y) < start.fontSize * 0.2))
        const isolatedFigureTail =
          next &&
          captionKind(start.text) === 'figure' &&
          !/[.!?]$/.test(previous.text.trim()) &&
          Math.abs(next.x - start.x) <= 2 &&
          /^[a-z]/.test(next.text) &&
          runs.every((line) => line.y >= start.y - 2 || line.y < page.height * 0.07) &&
          (page.graphicsBounds ?? []).some(
            (g) =>
              g.kind === 'image' &&
              (g.normalizedRect[2] - g.normalizedRect[0]) *
                (g.normalizedRect[3] - g.normalizedRect[1]) >
                0.08 &&
              g.normalizedRect[3] * page.height <= start.y + page.height / 256
          )
        if (
          !next ||
          (outdented &&
            lines.length > 1 &&
            /[.!?]$/.test(previous.text) &&
            previous.right - previous.x < (start.right - outdented.x) * 0.6 &&
            next.x - outdented.x >= start.fontSize * 0.8) ||
          next.y - previous.y >
            start.fontSize *
              (legendPage || boundedTableTail || isolatedFigureTail
                ? 2.5
                : centeredTitle ||
                    spacedFigureTail ||
                    provesRegularIsolatedCaption(start, runs, page)
                  ? 1.8
                  : 1.6) ||
          Math.abs(next.fontSize - start.fontSize) >
            (participantLine(next)
              ? start.fontSize * 0.35
              : centeredTitle
                ? 1.5
                : sideLegend ||
                    /^(?:Fig\.?|Figure)\s+\d+(?:\.?[A-Z](?:[-–][A-Z])?)?[.:]$/i.test(
                      start.text.trim()
                    )
                  ? 1.1
                  : 0.7) ||
          (captionKind(next.text) && !internalReference) ||
          (captionKind(start.text) === 'table' &&
            (separators.get(page.pageNumber) ?? []).some(
              ([x0, y0, x1, y1]) =>
                y0 === y1 &&
                y0 >= previous.bottom &&
                y0 <= next.y + next.fontSize * 0.35 &&
                x0 <= start.x + 2 &&
                x1 >= Math.max(previous.right, next.right) - 2
            ))
        )
          break
        lines.push(next)
        if (internalReference) ownedRuns.add(next)
      }
      const largerTerminal = findNativeCenteredLargerCaptionTail(
        start,
        lines,
        runs,
        page,
        rulesByPage.get(page.pageNumber) ?? []
      )
      if (largerTerminal) lines.push(largerTerminal)
      // Nature-style legends can flow from a left column into a right column.
      // Require a caption separator or an unfinished sentence with consecutive
      // panel labels, plus aligned small type. Ordinary neighboring prose stays separate.
      const lastPanel = [
        ...lines
          .map((l) => l.text)
          .join(' ')
          .matchAll(/(?:Note:|;)\s*([A-Y])\.\s/g)
      ].at(-1)?.[1]
      const lowerPanels = [
        ...lines
          .map((l) => l.text)
          .join(' ')
          .matchAll(/[:,]\s*([a-y])\s+(?=[a-z])/g)
      ]
      const lowerContinuation =
        lowerPanels.length >= 2 &&
        lowerPanels.every(
          (p, i) => !i || p[1].charCodeAt(0) === lowerPanels[i - 1][1].charCodeAt(0) + 1
        ) &&
        !/[.!?]$/.test(lines.at(-1).text)
          ? String.fromCharCode(lowerPanels.at(-1)[1].charCodeAt(0) + 1)
          : undefined
      const continuedPanel =
        captionKind(start.text) === 'figure' &&
        lastPanel &&
        /\b(?:between|and|of|with|for)$/.test(lines.at(-1).text)
          ? String.fromCharCode(lastPanel.charCodeAt(0) + 1)
          : undefined
      if ((start.text.includes('|') || continuedPanel || lowerContinuation) && lines.length >= 2) {
        const right = runs.find(
          (line) =>
            !completedCaptionRuns.has(line) &&
            line.x > Math.max(...lines.map((l) => l.right)) &&
            line.x - Math.max(...lines.map((l) => l.right)) <= start.fontSize * 4 &&
            Math.abs(line.y - start.y) <= 2 &&
            Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
            line.text.length >= 40 &&
            (start.text.includes('|') ||
              new RegExp(';\\s*' + continuedPanel + '\\.\\s').test(line.text) ||
              (lowerContinuation &&
                new RegExp(',\\s*' + lowerContinuation + '\\s').test(line.text))) &&
            !captionKind(line.text)
        )
        if (right) {
          lines.push(right)
          for (let count = 1; count < runs.length; count++) {
            const previous = lines.at(-1)
            const next = runs
              .filter((line) => line.y > previous.y + 2 && Math.abs(line.x - right.x) <= 2)
              .sort((a, b) => a.y - b.y)[0]
            if (
              !next ||
              next.y - previous.y > start.fontSize * 1.6 ||
              Math.abs(next.fontSize - start.fontSize) > 0.7 ||
              captionKind(next.text)
            )
              break
            lines.push(next)
          }
        }
      }
      // A translated title belongs to the same numbered table, but is usually
      // separated by more space than ordinary wrapped lines. Require its exact
      // number and a closing table rule instead of relaxing prose continuation.
      const tableNumber = /^Table\s+(\d+)\./i.exec(start.text)?.[1]
      if (tableNumber) {
        const previous = lines.at(-1)
        const translated = runs.find(
          (line) =>
            /^Tabelle\s+(\d+)\./i.exec(line.text)?.[1] === tableNumber &&
            Math.abs(line.x - start.x) <= 2 &&
            Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
            line.y > previous.y &&
            line.y - previous.y <= start.fontSize * 2
        )
        const border =
          translated &&
          (rulesByPage.get(page.pageNumber) ?? [])
            .filter(
              ([x0, y0, x1, y1]) =>
                y0 === y1 &&
                y0 >= translated.bottom &&
                y0 - translated.bottom <= start.fontSize * 4 &&
                Math.abs(x0 - start.x) <= 2 &&
                x1 >= Math.max(start.right, translated.right) - 2
            )
            .sort((a, b) => a[1] - b[1])[0]
        if (border) {
          const parts = runs
            .filter(
              (line) =>
                line.y >= translated.y &&
                line.bottom <= border[1] &&
                line.x >= border[0] - 2 &&
                line.right <= border[2] + 2
            )
            .sort((a, b) => a.y - b.y)
          if (
            parts[0] === translated &&
            parts.length <= 4 &&
            /\.$/.test(parts.at(-1).text) &&
            border[1] - parts.at(-1).bottom <= start.fontSize * 1.2 &&
            parts.every(
              (line, i) =>
                Math.abs(line.x - start.x) <= 2 &&
                Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
                (!i ||
                  (!/\.$/.test(parts[i - 1].text) &&
                    !captionKind(line.text) &&
                    !/^Tabelle\s+\d+/i.test(line.text) &&
                    line.y - parts[i - 1].y <= start.fontSize * 1.6))
            )
          )
            lines.push(...parts)
        }
      }
      // Supplementary-material indexes are laid out like a wrapped caption,
      // but enumerate several tables and figures in one prose block. Once the
      // continuation contains multiple supplementary labels and the matching
      // section heading is nearby, keep it out of caption ownership entirely.
      if (captionKind(start.text) === 'figure') {
        const section = lines.findIndex((line, n) =>
          isNumberedCaptionSectionBoundary(line, n, lines, runs)
        )
        if (section >= 0) lines.splice(section)
      }
      const candidateText = lines.map((line) => line.text).join(' ')
      const supplementaryLabels = [...candidateText.matchAll(/\b(?:Table|Figure)\s+S\d+\s*[:.]/gi)]
      const supplementaryHeading = runs.some(
        (line) =>
          /^Supplement(?:ary|al)\s+Materials$/i.test(line.text.trim()) &&
          line.y < start.y &&
          Math.abs(line.x - start.x) <= 2 &&
          start.y - line.bottom <= start.fontSize * 8
      )
      const supplementaryStart = /^(?:Table|Figure)\s+S\d+\s*[:.]/i.test(start.text.trim())
      if (supplementaryHeading && supplementaryStart && supplementaryLabels.length >= 2) continue
      if (captionKind(start.text) === 'figure' && lines.length >= 3) {
        // Native font switches can leave a second run on the same owned
        // caption line. Require a unique tight continuation inside the
        // already proven paragraph, preserving every literal fragment.
        const edge = Math.max(...lines.map((l) => l.right))
        const bottom = Math.max(...lines.map((l) => l.bottom))
        for (let i = 0; i < lines.length; i++) {
          let owned = lines[i]
          const additions = []
          for (;;) {
            let tails = runs.filter(
              (l) =>
                !lines.includes(l) &&
                !additions.includes(l) &&
                l.x >= owned.right - start.fontSize * 0.05 &&
                l.x - owned.right <= start.fontSize &&
                l.right <= edge &&
                l.y >= start.y &&
                l.bottom <= bottom &&
                Math.abs(l.fontSize - owned.fontSize) <= 0.1 &&
                ((Math.abs(l.bottom - owned.bottom) <= 0.1 &&
                  Math.abs(l.y - owned.y) <= start.fontSize * 0.2) ||
                  (l.text.length <= 2 &&
                    (Math.abs(l.x - owned.right) <= start.fontSize * 0.05 ||
                      (l.text === '√' &&
                        l.x >= owned.right &&
                        l.x - owned.right <= start.fontSize * 0.25)) &&
                    l.y < owned.bottom &&
                    l.bottom > owned.y))
            )
            // A source script can separate an ordinary suffix from the
            // first row of an already proven paragraph. Bridge its complete
            // literal only through a unique full-font junction; retain the
            // existing serializers and the paragraph's established bounds.
            if (tails.length === 0 && i === 0 && nativeParagraph) {
              const em = start.fontSize
              const validFont = (part) =>
                [part.x, part.y, part.width, part.height, part.fontSize].every(Number.isFinite) &&
                part.width > 0 &&
                part.height >= part.fontSize - 1e-8
              const parents = page.lines.filter(
                (part) =>
                  part.text.trim() &&
                  validFont(part) &&
                  Math.abs(part.fontSize - em) < em * 0.01 &&
                  Math.abs(part.x + part.width - owned.right) < em * 0.01 &&
                  Math.abs(part.y + part.height - owned.bottom) < em * 0.01
              )
              if (parents.length === 1 && owned.text.endsWith(parents[0].text)) {
                const parent = parents[0]
                const bridges = page.lines.filter(
                  (part) =>
                    /^[+−0-9-]{1,2}$/u.test(part.text.trim()) &&
                    validFont(part) &&
                    part.fontSize >= em * 0.5 &&
                    part.fontSize <= em * 0.8 &&
                    part.x >= owned.right &&
                    part.x - owned.right < em * 0.2 &&
                    part.y < parent.y &&
                    parent.y - part.y < em * 0.9 &&
                    part.y + part.height <= parent.y + parent.height
                )
                const pairs = bridges.flatMap((bridge) =>
                  runs
                    .filter(
                      (line) =>
                        !lines.includes(line) &&
                        !additions.includes(line) &&
                        line.text.length > 2 &&
                        !captionKind(line.text) &&
                        !/^Notes?\s*[:.]/iu.test(line.text) &&
                        line.x >= bridge.x + bridge.width &&
                        line.x - bridge.x - bridge.width <= em * 0.8 &&
                        line.right <= edge &&
                        line.y >= start.y &&
                        line.bottom <= bottom &&
                        Math.abs(line.fontSize - em) < em * 0.01 &&
                        Math.abs(line.bottom - owned.bottom) < em * 0.01 &&
                        Math.abs(line.y - parent.y) < em * 0.01 &&
                        !page.lines.some(
                          (part) =>
                            part.text.trim() &&
                            part !== parent &&
                            part !== bridge &&
                            (![part.x, part.y, part.width, part.height, part.fontSize].every(
                              Number.isFinite
                            ) ||
                              (part.x < line.x &&
                                part.x + part.width > owned.right &&
                                part.y < parent.y + parent.height &&
                                part.y + part.height > parent.y - em))
                        )
                    )
                    .map((tail) => ({ bridge, tail }))
                )
                if (pairs.length === 1) {
                  const { bridge, tail } = pairs[0]
                  tails = [{ ...tail, text: bridge.text + ' ' + tail.text }]
                }
              }
            }
            if (tails.length !== 1) break
            const tail = tails[0]
            additions.push(tail)
            owned = {
              ...owned,
              text: owned.text + ' ' + tail.text,
              right: tail.right,
              bottom: Math.max(owned.bottom, tail.bottom)
            }
          }
          if (additions.length) lines[i] = owned
        }
      }
      const candidate = {
        page: page.pageNumber,
        lines: lines.map(({ text }) => text),
        rect: [
          Math.min(...lines.map((line) => line.x)),
          Math.min(...lines.map((line) => line.y)),
          Math.max(...lines.map((line) => line.right)),
          Math.max(...lines.map((line) => line.bottom))
        ]
      }
      const raisedFragments = recoverNativeRaisedCaptionFragments(
        page,
        candidate,
        separators.get(page.pageNumber) ?? []
      )
      if (raisedFragments)
        candidate.lines = groupPageLines({ ...page, lines: raisedFragments }).map(
          ({ text }) => text
        )
      const scriptLines = nativeCaptionRaisedIndexLines(page, candidate)
      if (scriptLines) candidate.lines = scriptLines
      const literalFragments = nativeCaptionLiteralFragments(page, candidate)
      if (literalFragments) Object.assign(candidate, literalFragments)
      // Complete literal baseline recovery may split connected source rows.
      // The earlier grouped rows must not overwrite that conserved paragraph.
      const inlineFragments = literalFragments
        ? undefined
        : nativeCaptionOwnedInlineFragments(
            page,
            candidate,
            lines,
            separators.get(page.pageNumber) ?? []
          )
      if (inlineFragments) Object.assign(candidate, inlineFragments)
      if (isCoordinatedFigureSubject(candidate.lines.join(' '))) continue
      if (nativeParagraph) for (const line of lines) ownedRuns.add(line)
      for (const line of lines) completedCaptionRuns.add(line)
      candidates.push(candidate)
    }
  }
  return candidates
}

// Recover a spaced mathematical caption only after its complete native graphic
// has one existing association. Same-stream whole text and font quadrilaterals
// prove the paragraph boundary; this does not publish new source ownership.
export function recoverStyledMathCaption(candidate, page, rules, fonts, context) {
  const literalControls = nativeCaptionProvenControlFragments(page, candidate, fonts, {
    ...context,
    rules
  })
  if (literalControls) return literalControls
  const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
  const literal = (s) => s.replace(/\s/gu, '')
  if (
    !candidate ||
    candidate.page !== page.pageNumber ||
    candidate.regions ||
    candidate.lines.length !== 1 ||
    !/^(?:Fig(?:ure)?\.?)\s+[A-Z]?\d+[.:]/u.test(candidate.lines[0]) ||
    /[.!?]$/u.test(candidate.lines[0]) ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.graphicsBounds) ||
    !page.graphicsBounds.length ||
    !Array.isArray(context?.inventory) ||
    !Array.isArray(context?.content?.items) ||
    !Array.isArray(context?.associations) ||
    !finite(context?.viewport?.transform, 6)
  )
    return
  const raw = context.content.items,
    styles = context.content.styles,
    inventory = []
  const carrierCounts = (value) => {
    const counts = new Map(),
      active = new Set()
    const walk = (v) => {
      if (!v || typeof v !== 'object') return true
      if (active.has(v)) return false
      active.add(v)
      if (Number.isSafeInteger(v.pageNumber) && Number.isSafeInteger(v.index)) {
        const key = v.pageNumber + ':' + v.index
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      for (const x of Object.values(v)) if (!walk(x)) return false
      active.delete(v)
      return true
    }
    return walk(value) ? counts : undefined
  }
  const rawCounts = carrierCounts(context.content),
    fontCounts = carrierCounts(fonts)
  if (!rawCounts || !fontCounts) return
  // All inventory entries are direct whole raw items from this single content object.
  const sourceKeys = new Set()
  for (const t of context.inventory) {
    const s = t.sourceItem,
      r = raw[s?.index]
    if (
      !s ||
      s.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(s.index) ||
      s.index < 0 ||
      sourceKeys.has(s.index) ||
      s.text !== t.text ||
      r?.str !== t.text ||
      r.sourceItem?.pageNumber !== s.pageNumber ||
      r.sourceItem.index !== s.index ||
      r.sourceItem.text !== s.text ||
      rawCounts.get(s.pageNumber + ':' + s.index) !== 1 ||
      r.fontName !== t.fontName ||
      !finite(t.rect, 4) ||
      !finite(r.transform, 6) ||
      ['sourceToken', 'sourceSegment', 'sourceItems', 'sourceSegments'].some(
        (k) => t[k] !== undefined || r[k] !== undefined
      )
    )
      return
    sourceKeys.add(s.index)
    const [a, b, c, d, x, y] = r.transform,
      h = Math.hypot(a, b),
      v = Math.hypot(c, d),
      m = context.viewport.transform
    if (
      !(h > 0 && v > 0) ||
      !Number.isFinite(r.width) ||
      !Number.isFinite(r.height) ||
      r.width <= 0 ||
      r.height <= 0
    )
      return
    const points = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ].map(([u, z]) => {
      const px = x + (u * r.width * a) / h + (z * r.height * c) / v,
        py = y + (u * r.width * b) / h + (z * r.height * d) / v
      return [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]]
    })
    const rect = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
    inventory.push({ ...t, advanceRect: t.rect, rect })
  }
  if (raw.filter((r) => typeof r.str === 'string' && r.str.trim()).length !== inventory.length)
    return
  const starts = page.lines.filter(
    (l) =>
      l.text === candidate.lines[0] &&
      Math.abs(l.x - candidate.rect[0]) < 0.02 &&
      Math.abs(l.y - candidate.rect[1]) < 0.02
  )
  if (starts.length !== 1) return
  const start = starts[0],
    em = start.height,
    right = start.x + start.width
  if (!(em > 0) || start.width < em * 12 || Math.abs(start.fontSize - em) > 0.02) return
  const near = page.lines
    .filter((l) => l.text.trim() && l.y >= start.y && l.x < right && l.x + l.width > start.x)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  if (near[0] !== start) return
  const rowParts = (row) => {
    const parts = inventory.filter(
      (t) =>
        t.rect[0] < row.x + row.width &&
        t.rect[2] > row.x &&
        t.rect[1] < row.y + row.height &&
        t.rect[3] > row.y
    )
    if (
      !parts.length ||
      parts.some(
        (t) =>
          !t.horizontal ||
          t.rect[0] < row.x - 0.02 ||
          t.rect[2] > row.x + row.width + 0.02 ||
          t.rect[1] < row.y - 0.02 ||
          t.rect[3] > row.y + row.height + 0.02
      )
    )
      return
    if (literal(parts.map((t) => t.text).join('')) !== literal(row.text)) return
    for (const t of parts) {
      const r = raw[t.sourceItem.index],
        style = styles?.[r.fontName],
        matches = fonts.filter((f) => f.sourceItem?.index === t.sourceItem.index)
      if (
        !r.fontName ||
        style?.vertical !== false ||
        !Number.isFinite(style.ascent) ||
        !Number.isFinite(style.descent) ||
        fontCounts.get(page.pageNumber + ':' + t.sourceItem.index) !== 1 ||
        matches.length !== 1 ||
        matches[0].text !== t.text ||
        matches[0].sourceItem.text !== t.text ||
        matches[0].sourceItem.pageNumber !== page.pageNumber ||
        !finite(matches[0].rect, 4) ||
        matches[0].rect.some((v, i) => Math.abs(v - t.advanceRect[i]) > 1e-7) ||
        Math.abs(t.baseline - (row.y + row.height)) > 0.02
      )
        return
    }
    return parts
  }
  const first = rowParts(start)
  if (!first || new Set(first.map((t) => t.fontName)).size !== 1) return
  const family = first[0].fontName,
    rows = [start],
    owned = [...first]
  let pitch, following
  for (const row of near.slice(1)) {
    const parts = rowParts(row)
    if (!parts) return
    const dominant = parts.filter((t) => t.fontName === family && Math.abs(t.height - em) < 0.02)
    if (!dominant.length) {
      following = { row, parts }
      break
    }
    if (
      rows.length >= 8 ||
      Math.abs(row.x - start.x) > 0.02 ||
      row.x + row.width > right + em * 0.05 ||
      row.height !== em ||
      !/^[\p{Ll}]/u.test(row.text) ||
      /^(?:Fig(?:ure)?|Table|Note)\b/iu.test(row.text)
    )
      return
    const gap = row.y - rows.at(-1).y
    // Use the repeated native baseline; do not alter the generic gap limit.
    if (!pitch) {
      if (gap <= em * 1.6 || gap > em * 2.25) return
      pitch = gap
    } else if (Math.abs(gap - pitch) > em * 0.05) return
    const different = parts.filter((t) => t.fontName !== family)
    if (
      different.some(
        (t) =>
          t.text.trim().length !== 1 ||
          /[\p{L}\p{N}]/u.test(t.text) ||
          t.rect[2] - t.rect[0] > em ||
          t.height < em * 0.8 ||
          t.height > em * 1.1
      ) ||
      dominant.reduce((n, t) => n + t.text.replace(/\s/gu, '').length, 0) <
        literal(row.text).length * 0.8
    )
      return
    rows.push(row)
    owned.push(...parts)
    if (/[.!?]$/u.test(row.text.trim())) {
      const next = near[near.indexOf(row) + 1],
        nextParts = next && rowParts(next)
      if (!nextParts) return
      following = { row: next, parts: nextParts }
      break
    }
  }
  if (rows.length < 3 || !following || !pitch || !/[.!?]$/u.test(rows.at(-1).text.trim())) return
  const last = rows.at(-1),
    body = following.row
  if (
    rows.slice(1, -1).some((r) => r.width < start.width * 0.85) ||
    last.width >= start.width * 0.75 ||
    following.parts.some((t) => t.fontName === family) ||
    new Set(following.parts.map((t) => t.fontName)).size !== 1 ||
    body.y - last.y < pitch * 2 ||
    body.x - start.x < em ||
    body.x - start.x > em * 4 ||
    body.x + body.width > right + em * 0.1
  )
    return
  const rect = [start.x, start.y, Math.max(...rows.map((r) => r.x + r.width)), last.y + last.height]
  const chosen = new Set(owned)
  if (
    inventory.some(
      (t) =>
        !chosen.has(t) &&
        t.rect[0] < rect[2] &&
        t.rect[2] > rect[0] &&
        t.rect[1] < rect[3] &&
        t.rect[3] > rect[1]
    ) ||
    page.lines.some(
      (l) =>
        !rows.includes(l) &&
        l.text.trim() &&
        l.x < rect[2] &&
        l.x + l.width > rect[0] &&
        l.y < rect[3] &&
        l.y + l.height > rect[1]
    ) ||
    rules.some(
      (r) => !finite(r, 4) || (r[0] < rect[2] && r[2] > rect[0] && r[1] < rect[3] && r[3] > rect[1])
    )
  )
    return
  // Reuse the unique already-associated graphic. Never choose a new figure or crop.
  if (context.associations.length !== 1) return
  const graphic = context.associations[0],
    grect = graphic.rect
  if (
    !finite(grect, 4) ||
    graphic.captionLines ||
    graphic.captionRect ||
    graphic.caption?.regions ||
    graphic.caption?.page !== candidate.page ||
    JSON.stringify(graphic.caption.lines) !== JSON.stringify(candidate.lines) ||
    JSON.stringify(graphic.caption.rect) !== JSON.stringify(candidate.rect) ||
    graphic.graphicsCount !== page.graphicsBounds.length ||
    grect[3] >= start.y ||
    start.y - grect[3] > em * 4 ||
    grect[0] < start.x ||
    grect[2] > right
  )
    return
  for (const g of page.graphicsBounds) {
    const r = g.normalizedRect
    if (
      !finite(r, 4) ||
      r[0] > r[2] ||
      r[1] > r[3] ||
      !Number.isSafeInteger(g.operationIndex) ||
      g.operationIndex < 0 ||
      r
        .map((v, i) => v * (i % 2 ? page.height : page.width))
        .some((v, i) => (i < 2 ? v < grect[i] : v > grect[i])) ||
      (r[0] * page.width < rect[2] &&
        r[2] * page.width > rect[0] &&
        r[1] * page.height < rect[3] &&
        r[3] * page.height > rect[1])
    )
      return
  }
  if (new Set(page.graphicsBounds.map((g) => g.operationIndex)).size !== page.graphicsBounds.length)
    return
  return { lines: rows.map((r) => r.text), rect }
}

// Refuse a phantom caption only inside a complete native image-credit list.
// This classifies metadata; all native text, regions and painted images stay intact.
function proveNativeCreditReference(candidate, page, context, records, rules) {
  const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6),
    hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    rectangle = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]
  if (
    ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
    page.lines.some(
      (l) =>
        !l ||
        typeof l.text !== 'string' ||
        ![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
        l.width <= 0 ||
        l.height <= 0 ||
        l.fontSize <= 0
    ) ||
    rules.length ||
    page.graphicsBounds.length ||
    candidate.lines.length < 3 ||
    candidate.lines.length > 8
  )
    return false
  const headings = records.filter((z) => /^image credits$/iu.test(z.r.str))
  if (headings.length !== 1) return false
  const heading = headings[0],
    raw = context.content.items,
    rows = page.lines.filter((l) => l.y > heading.rect[3]),
    startPattern = /^(?:Figs?\.|Figures?)\s+\d+[A-Za-z]?(?:\s*(?:,|and)\s*\d+[A-Za-z]?)*:\s+/u,
    starts = rows.filter((l) => startPattern.test(l.text))
  if (starts.length !== 3 || starts[2].text !== candidate.lines[0]) return false
  const first = starts[0],
    em = first.fontSize,
    selectedRows = rows.slice(rows.indexOf(first)),
    groups = [],
    owned = []
  if (
    !(em > 0) ||
    heading.r.height <= em ||
    heading.rect[0] !== first.x ||
    heading.envelope[0] < 0 ||
    heading.envelope[1] < 0 ||
    heading.envelope[2] > page.width ||
    heading.envelope[3] > first.y ||
    page.lines.filter(
      (l) =>
        l.text === heading.r.str &&
        l.fontSize === heading.r.height &&
        same(rectangle(l), heading.rect)
    ).length !== 1
  )
    return false
  if (
    heading.r.transform[0] !== heading.r.height ||
    heading.r.transform[1] !== 0 ||
    heading.r.transform[2] !== 0 ||
    heading.r.transform[3] !== heading.r.height ||
    records.some((z) => z !== heading && hit(z.envelope, heading.envelope)) ||
    page.lines.filter((l) => l.text.trim() && hit(rectangle(l), heading.envelope)).length !== 1
  )
    return false
  for (const line of selectedRows) {
    const bounds = rectangle(line)
    if (
      ![...bounds, line.fontSize].every(Number.isFinite) ||
      line.fontSize !== em ||
      line.height !== em ||
      Math.abs(line.x - first.x) > 1e-6 ||
      line.width <= 0 ||
      bounds[0] < 0 ||
      bounds[1] < 0 ||
      bounds[2] > page.width ||
      bounds[3] > page.height
    )
      return false
    const matches = records.filter(
      (z) => Math.abs(z.rect[1] - line.y) < 1e-6 && Math.abs(z.rect[3] - bounds[3]) < 1e-6
    )
    if (
      !matches.length ||
      matches.some(
        (z) =>
          z.r.height !== em ||
          z.r.transform[0] !== em ||
          z.r.transform[1] !== 0 ||
          z.r.transform[2] !== 0 ||
          z.r.transform[3] !== em ||
          z.envelope[0] < 0 ||
          z.envelope[1] < 0 ||
          z.envelope[2] > page.width ||
          z.envelope[3] > page.height
      )
    )
      return false
    const indices = matches.map((z) => z.index),
      lo = indices[0],
      hi = indices.at(-1)
    if (owned.length && lo <= owned.at(-1).index) return false
    const literal = raw
      .slice(lo, hi + 1)
      .map((r) => r.str ?? '')
      .join('')
    const union = [
      Math.min(...matches.map((z) => z.rect[0])),
      line.y,
      Math.max(...matches.map((z) => z.rect[2])),
      bounds[3]
    ]
    if (
      literal !== line.text ||
      !same(union, bounds) ||
      page.lines.filter((l) => l.text === line.text && same(rectangle(l), bounds)).length !== 1
    )
      return false
    if (startPattern.test(line.text)) groups.push([])
    if (!groups.length) return false
    groups.at(-1).push({ line, matches })
    owned.push(...matches)
  }
  if (groups.length !== 3 || owned.at(-1)?.index !== records.at(-1)?.index) return false
  const fontRoles = []
  for (const group of groups) {
    if (group.length < 3 || group.length > 8) return false
    const head = group[0],
      prefix = head.line.text.match(startPattern)?.[0].trim(),
      headingFont = head.matches[0].r.fontName,
      titleAt = head.matches.findIndex((z) => z.r.fontName !== headingFont)
    if (!prefix || titleAt < 1 || titleAt >= head.matches.length) return false
    const prefixItems = head.matches.slice(0, titleAt),
      title = head.matches.slice(titleAt),
      titleFont = title[0].r.fontName,
      bodyFont = group[1].matches[0].r.fontName,
      prefixText = raw
        .slice(prefixItems[0].index, prefixItems.at(-1).index + 1)
        .map((r) => r.str ?? '')
        .join('')
    if (
      prefixText !== prefix ||
      title.some((z) => z.r.fontName !== titleFont) ||
      new Set([headingFont, titleFont, bodyFont]).size !== 3 ||
      !/^[“"][^”"]+[”"]\s+by\s+\S/u.test(head.line.text.slice(prefix.length).trim())
    )
      return false
    fontRoles.push([headingFont, titleFont, bodyFont])
    const fullText = group.map(({ line }) => line.text).join(' ')
    if (
      !/\blicensed under\b/u.test(fullText) ||
      !/[.!?]$/u.test(fullText) ||
      (fullText.match(/https?:\/\/[^\s)]+/gu) ?? []).length < 2
    )
      return false
    for (let n = 0; n < group.length; n++) {
      const { line, matches } = group[n]
      if (
        (n && (line.y - group[n - 1].line.y < em || line.y - group[n - 1].line.y > em * 1.5)) ||
        (n < group.length - 1 && Math.abs(line.width - first.width) > em * 0.05) ||
        (n && matches.some((z) => z.r.fontName !== bodyFont))
      )
        return false
    }
  }
  if (fontRoles.some((v) => v.some((font, i) => font !== fontRoles[0][i]))) return false
  for (let i = 1; i < groups.length; i++) {
    const previous = groups[i - 1].at(-1).line,
      next = groups[i][0].line,
      gap = next.y - previous.y
    if (!(gap > em * 1.5 && gap < em * 2)) return false
  }
  const last = groups[2],
    union = [
      Math.min(...last.map(({ line }) => line.x)),
      last[0].line.y,
      Math.max(...last.map(({ line }) => line.x + line.width)),
      last.at(-1).line.y + last.at(-1).line.height
    ]
  if (
    !same(union, candidate.rect) ||
    last.length !== candidate.lines.length ||
    last.some(({ line }, i) => line.text !== candidate.lines[i])
  )
    return false
  const box = [
    Math.min(...owned.map((z) => z.envelope[0])),
    Math.min(...owned.map((z) => z.envelope[1])),
    Math.max(...owned.map((z) => z.envelope[2])),
    Math.max(...owned.map((z) => z.envelope[3]))
  ]
  if (
    records.some((z) => !owned.includes(z) && hit(z.envelope, box)) ||
    page.lines.filter((l) => l.text?.trim() && hit(rectangle(l), box)).length !==
      selectedRows.length
  )
    return false
  return true
}

function nativePanelReferenceContinuation(start, runs, page, rules, captionKind) {
  if (
    !/^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\.[a-z]\s+(?:and|or)\s+\p{Ll}/u.test(start.text) ||
    /[.!?:;]$/u.test(start.text.trim()) ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.graphicsBounds) ||
    !Array.isArray(page.lines) ||
    !Array.isArray(rules)
  )
    return false
  if (
    ![page.width, page.height].every((n) => Number.isFinite(n) && n > 0) ||
    page.lines.some(
      (l) =>
        l.text?.trim() &&
        (![l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) ||
          l.width <= 0 ||
          l.height <= 0 ||
          l.fontSize <= 0)
    )
  )
    return false
  const em = start.fontSize,
    valid = (r) =>
      [r.x, r.y, r.right, r.bottom, r.fontSize].every(Number.isFinite) &&
      r.right > r.x &&
      r.bottom > r.y
  if (!(em > 0) || !valid(start)) return false
  const aligned = (r) =>
    r !== start &&
    valid(r) &&
    r.text.length > 30 &&
    !captionKind(r.text) &&
    Math.abs(r.fontSize - em) < em * 0.015 &&
    Math.abs(r.x - start.x) < em * 0.05 &&
    Math.abs(r.right - start.right) < em * 0.05
  const before = runs.filter(
    (r) =>
      aligned(r) &&
      /\b(?:shown|displayed|given|plotted)\s+in$/u.test(r.text.trim()) &&
      r.bottom <= start.y &&
      start.y - r.y > em &&
      start.y - r.y < em * 2
  )
  const after = runs.filter(
    (r) =>
      aligned(r) &&
      /^\p{Ll}/u.test(r.text) &&
      r.y >= start.bottom &&
      r.y - start.y > em &&
      r.y - start.y < em * 2
  )
  if (
    before.length !== 1 ||
    after.length !== 1 ||
    Math.abs(start.y - before[0].y - (after[0].y - start.y)) > em * 0.015
  )
    return false
  const rows = [before[0], start, after[0]]
  if (rows.some((r) => r.x < 0 || r.y < 0 || r.right > page.width || r.bottom > page.height))
    return false
  const box = [start.x, before[0].y, start.right, after[0].bottom]
  const overlaps = (r) =>
    Math.min(r[0], r[2]) < box[2] &&
    Math.max(r[0], r[2]) > box[0] &&
    Math.min(r[1], r[3]) < box[3] &&
    Math.max(r[1], r[3]) > box[1]
  const native = page.lines.filter(
    (l) => l.text?.trim() && overlaps([l.x, l.y, l.x + l.width, l.y + l.height])
  )
  if (
    native.length !== 3 ||
    !rows.every(
      (r) =>
        native.filter(
          (n) =>
            n.text === r.text &&
            n.x === r.x &&
            n.y === r.y &&
            n.x + n.width === r.right &&
            n.y + n.height === r.bottom &&
            n.fontSize === r.fontSize
        ).length === 1
    )
  )
    return false
  const independent = (r) =>
    overlaps(r) &&
    !rows.some(
      (l) =>
        Math.min(r[0], r[2]) >= l.x &&
        Math.max(r[0], r[2]) <= l.right &&
        Math.min(r[1], r[3]) >= l.y &&
        Math.max(r[1], r[3]) <= l.bottom
    )
  if (
    rules.some(
      (r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite) || independent(r)
    )
  )
    return false
  return !page.graphicsBounds.some(
    (g) =>
      !['path', 'image'].includes(g.kind) ||
      !Array.isArray(g.normalizedRect) ||
      g.normalizedRect.length !== 4 ||
      !g.normalizedRect.every(Number.isFinite) ||
      independent(g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
  )
}

// Explicit native/raster completion leaves the ordinary caption threshold unchanged.
export async function recoverNativeCaptionLane(input) {
  const { recoverNativeClosedCaptionLane } =
    await import('./literature-pdf-native-caption-lane.mjs')
  return recoverNativeClosedCaptionLane(input)
}

// Complete a terminal caption row hidden by a larger inline punctuation glyph.
// The original generic row/font gate stays unchanged; every selected word must
// belong to one literal, contiguous native stream and the next plate stays separate.
export function recoverNativeMixedFontCaptionTail(candidate, page, tokens, context) {
  try {
    if (
      !candidate ||
      candidate.page !== page.pageNumber ||
      candidate.lines?.length !== 1 ||
      candidate.regions ||
      !/^(?:Fig\.?|Figure)\s+[A-Z]?\d+[.:]\s+\p{L}/u.test(candidate.lines[0]) ||
      /[.!?]$/u.test(candidate.lines[0].trim()) ||
      page.invalidGraphicsBounds !== 0 ||
      context?.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '')
    )
      return
    const valid = (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[0] < r[2] &&
        r[1] < r[3],
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-7 : v <= a[i] + 1e-7)),
      compact = (s) => s.replace(/\s/gu, ''),
      rect = candidate.rect
    if (!valid(rect) || !Array.isArray(page.lines) || !Array.isArray(page.graphicsBounds)) return
    const inv = nativePageTextPacketInventory(page, tokens, context, true)
    if (!inv) return
    const first = inv.records.filter((r) => hit(r.rect, rect)).sort((a, b) => a.index - b.index),
      matches = page.lines.filter(
        (l) =>
          l.text === candidate.lines[0] &&
          [l.x, l.y, l.x + l.width, l.y + l.height].every((v, i) => Math.abs(v - rect[i]) < 1e-7)
      )
    if (
      matches.length !== 1 ||
      first.length < 4 ||
      first.some((r) => !inside(rect, r.rect)) ||
      compact(first.map((r) => r.r.str).join('')) !== compact(candidate.lines[0])
    )
      return
    const following = page.lines
        .filter((l) => l.text?.trim() && l.y > rect[1] && l.x < rect[2] && l.x + l.width > rect[0])
        .sort((a, b) => a.y - b.y),
      tail = following[0]
    if (
      !tail ||
      !/^[\p{Ll}][\p{L}-]{2,20}[.!?]$/u.test(tail.text.trim()) ||
      Math.abs(tail.x - rect[0]) > 0.02 ||
      tail.width >= (rect[2] - rect[0]) * 0.3 ||
      tail.fontSize >= matches[0].fontSize - 0.7
    )
      return
    const tailRect = [tail.x, tail.y, tail.x + tail.width, tail.y + tail.height],
      tailOwners = inv.records.filter((r) => hit(r.rect, tailRect)),
      last = first.at(-1)
    if (
      tailOwners.length !== 1 ||
      !inside(tailRect, tailOwners[0].rect) ||
      compact(tailOwners[0].r.str) !== compact(tail.text)
    )
      return
    const terminal = tailOwners[0],
      em = terminal.r.height,
      markerEnd = first.findIndex((_, i) =>
        /^(?:Fig\.?|Figure)[A-Z]?\d+[.:]$/u.test(
          compact(
            first
              .slice(0, i + 1)
              .map((r) => r.r.str)
              .join('')
          )
        )
      ),
      body = first.slice(markerEnd + 1),
      punctuation = body.filter(
        (r) => r.r.fontName !== terminal.r.fontName || Math.abs(r.r.height - em) > 0.02
      )
    if (
      !(em > 0) ||
      markerEnd < 0 ||
      body.length < 2 ||
      terminal.index <= last.index ||
      context.content.items.slice(last.index + 1, terminal.index).some((r) => r.str?.trim()) ||
      inv.records.some(
        (r) => r.index > first[0].index && r.index < terminal.index && !first.includes(r)
      ) ||
      Math.abs(tail.height - em) > 0.02 ||
      Math.abs(tail.fontSize - em) > 0.02 ||
      first.some(
        (r, i) =>
          Math.abs(r.rect[3] - rect[3]) > 0.02 ||
          (i &&
            (r.rect[0] < first[i - 1].rect[2] - em * 0.02 ||
              r.rect[0] - first[i - 1].rect[2] > em * 0.5))
      ) ||
      punctuation.length !== 1 ||
      !/^[-–—]$/u.test(punctuation[0].r.str) ||
      punctuation[0].r.height <= em ||
      punctuation[0].r.height > em * 1.35 ||
      body
        .filter((r) => !punctuation.includes(r))
        .some((r) => r.r.fontName !== terminal.r.fontName || Math.abs(r.r.height - em) > 0.02) ||
      compact(
        body
          .filter((r) => !punctuation.includes(r))
          .map((r) => r.r.str)
          .join('')
      ).length <
        compact(candidate.lines[0]).length * 0.65 ||
      terminal.rect[3] - last.rect[3] < em ||
      terminal.rect[3] - last.rect[3] > em * 1.6
    )
      return
    const closed = [rect[0], rect[1], rect[2], tailRect[3]],
      chosen = [...first, terminal]
    if (
      inv.records.some((r) => !chosen.includes(r) && hit(r.rect, closed)) ||
      page.lines.some(
        (l) =>
          l !== matches[0] &&
          l !== tail &&
          l.text?.trim() &&
          hit([l.x, l.y, l.x + l.width, l.y + l.height], closed)
      )
    )
      return
    const lowerCaption = following.find(
        (l) => l.y > tailRect[3] && captionKind(l.text) === 'figure'
      ),
      images = page.graphicsBounds
        .filter(
          (g) =>
            g.kind === 'image' &&
            valid(g.normalizedRect) &&
            /^[a-f0-9]{64}$/u.test(g.imageHash ?? '')
        )
        .flatMap((g) => {
          const native = inv.evidence.images.filter((i) => i.operationIndex === g.operationIndex)
          return native.length === 1 &&
            valid(native[0].rect) &&
            inside(
              g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
              native[0].rect
            )
            ? [{ g, box: native[0].rect }]
            : []
        }),
      below =
        lowerCaption &&
        images.filter(
          ({ box }) =>
            box[0] >= rect[0] - em &&
            box[2] <= rect[2] + em &&
            box[1] > tailRect[3] + em &&
            box[3] <= lowerCaption.y + page.height / 256 &&
            box[3] - box[1] > em * 4 &&
            box[2] - box[0] > (rect[2] - rect[0]) * 0.5
        )
    if (
      !lowerCaption ||
      !below ||
      below.length !== 1 ||
      lowerCaption.y - tailRect[3] > em * 20 ||
      !images.some(
        ({ box }) =>
          box[0] >= rect[0] - em &&
          box[2] <= rect[2] + em &&
          box[3] <= rect[3] &&
          rect[1] - box[3] < em * 2 &&
          box[3] - box[1] > em * 4
      ) ||
      page.graphicsBounds.some(
        (g) =>
          !valid(g.normalizedRect) ||
          hit(
            g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
            tailRect
          )
      )
    )
      return
    const corridor = [rect[0], tailRect[3], rect[2], below[0].box[1]]
    if (
      inv.records.some((r) => hit(r.rect, corridor)) ||
      page.lines.some(
        (l) => l.text?.trim() && hit([l.x, l.y, l.x + l.width, l.y + l.height], corridor)
      )
    )
      return
    return { ...candidate, lines: [...candidate.lines, tail.text], rect: closed }
  } catch {
    return
  }
}

// A separate single-spaced centered mathematical paragraph. Every native row,
// small-script edge and the following larger body boundary closes before metadata
// is extended. This supplies no figure pixels or translation/content policy.
export function recoverNativeSingleSpacedMathCaptionTail(candidate, page, tokens, context, scope) {
  try {
    if (
      candidate?.page !== page.pageNumber ||
      candidate.lines?.length !== 1 ||
      candidate.regions ||
      !/^(?:Fig\.?|Figure)\s+[A-Z]?\d+[.:]\s+\p{L}/iu.test(candidate.lines[0]) ||
      /[.!?]$/u.test(candidate.lines[0].trim()) ||
      page.rotation !== 0 ||
      page.renderRotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      context?.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      !Array.isArray(scope?.captions) ||
      !Array.isArray(scope.figures) ||
      !Array.isArray(scope.tables) ||
      !scope.figures.includes(scope.figure) ||
      !scope.captions.includes(scope.figure.caption)
    )
      return
    const originalContext = context,
      own = nativeRecoveryOwnValues(context)
    if (!own) return
    const keys = Object.keys(own)
    // Bind every consumed native renderer input; the separately owned running-head
    // witness includes PDF page methods and is not a caption metadata input.
    context = Object.fromEntries(
      [
        'operators',
        'glyphBounds',
        'captionLaneRaster',
        'opaqueRasterImages',
        'graphicsBounds',
        'viewport',
        'content',
        'pageNumber',
        'sourceSha256'
      ].map((k) => [k, own[k]])
    )
    const retained = retainNativeRecoveryInputs(
      [candidate, page, tokens, context, scope],
      context.viewport
    )
    const current =
      retained &&
      (() => {
        const next = nativeRecoveryOwnValues(originalContext)
        return (
          retained() &&
          next &&
          Object.keys(next).length === keys.length &&
          keys.every((k) => Object.hasOwn(next, k) && Object.is(next[k], own[k]))
        )
      })
    if (!current) return
    const packet = nativePageTextPacketInventory(page, tokens, context, true)
    if (!packet) return
    const runs = groupPageLines(page),
      start = runs.filter(
        (r) =>
          r.text === candidate.lines[0] &&
          [r.x, r.y, r.right, r.bottom].every((n, i) => Math.abs(n - candidate.rect[i]) < 0.02)
      )
    if (start.length !== 1) return
    const first = start[0],
      em = first.fontSize,
      center = (first.x + first.right) / 2
    if (!(em > 0) || first.right - first.x < em * 25) return
    const rows = [first],
      following = runs
        .filter((r) => r.y > first.y + em * 0.5)
        .sort((a, b) => a.y - b.y || a.x - b.x)
    for (const row of following) {
      const previous = rows.at(-1),
        gap = row.y - previous.y
      if (
        rows.length >= 8 ||
        gap < em * 0.95 ||
        gap > em * 1.3 ||
        Math.abs(row.fontSize - em) > em * 0.01 ||
        Math.abs((row.x + row.right) / 2 - center) > em * 0.05 ||
        row.x < first.x - em ||
        row.right > first.right + em ||
        captionKind(row.text) ||
        /^Notes?\s*[:.]/iu.test(row.text)
      )
        break
      rows.push(row)
      if (/[.!?]$/u.test(row.text.trim())) break
    }
    const last = rows.at(-1)
    if (
      rows.length < 4 ||
      rows.length > 8 ||
      !/[.!?]$/u.test(last.text.trim()) ||
      last.right - last.x >= (first.right - first.x) * 0.8
    )
      return
    const rect = [
        Math.min(...rows.map((r) => r.x)),
        candidate.rect[1],
        Math.max(...rows.map((r) => r.right)),
        Math.max(...rows.map((r) => r.bottom))
      ],
      hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3],
      inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 0.02 : n <= a[i] + 0.02))
    const owned = packet.records.filter((r) => hit(rect, r.rect)).sort((a, b) => a.index - b.index)
    if (
      !owned.length ||
      owned.some((r) => !inside(rect, r.rect)) ||
      packet.records.some(
        (r) => r.index >= owned[0].index && r.index <= owned.at(-1).index && !owned.includes(r)
      )
    )
      return
    const perRow = rows.map((row) =>
      owned.filter((r) => hit([row.x, row.y, row.right, row.bottom], r.rect))
    )
    if (perRow.some((rr) => !rr.length) || new Set(perRow.flat()).size !== owned.length) return
    const main = perRow[0].find((r) => /[A-Za-z]{3}/u.test(r.r.str)),
      baselines = [],
      scriptGroups = []
    if (!main) return
    for (const rr of perRow) {
      const normal = rr.filter((r) => Math.abs(r.r.height - em) < em * 0.01),
        words = normal.filter((r) => /[A-Za-z]{3}/u.test(r.r.str)),
        base = words[0]?.r.transform[5]
      if (
        !words.length ||
        words.some(
          (r) => r.r.fontName !== main.r.fontName || Math.abs(r.r.transform[5] - base) > 0.001
        ) ||
        normal.some((r) => Math.abs(r.r.transform[5] - base) > 0.001)
      )
        return
      baselines.push(base)
      for (const r of rr) {
        const a = r.r
        if (
          a.dir !== 'ltr' ||
          a.transform[0] <= 0 ||
          a.transform[1] !== 0 ||
          a.transform[2] !== 0 ||
          a.transform[3] !== a.height ||
          a.sourceItem?.pageNumber !== page.pageNumber ||
          a.sourceItem.index !== r.index ||
          a.sourceItem.text !== a.str
        )
          return
        if (normal.includes(r)) continue
        if (
          a.height < em * 0.65 ||
          a.height > em * 0.68 ||
          a.transform[5] - base < em * 0.2 ||
          a.transform[5] - base > em * 0.7
        )
          return
      }
      const small = rr.filter((r) => !normal.includes(r))
      for (let i = 0; i < small.length;) {
        const cluster = [small[i++]]
        while (
          i < small.length &&
          small[i].index === cluster.at(-1).index + 1 &&
          Math.abs(small[i].r.transform[5] - cluster[0].r.transform[5]) < 0.001 &&
          Math.abs(
            small[i].r.transform[4] - cluster.at(-1).r.transform[4] - cluster.at(-1).r.width
          ) <
            em * 0.02
        )
          cluster.push(small[i++])
        const anchor = normal.filter((r) => r.index < cluster[0].index).at(-1),
          text = cluster.map((r) => r.r.str).join('')
        if (
          !anchor ||
          !/^[−-]?\d{1,3}$/u.test(text) ||
          !/[\p{L}\d]$/u.test(anchor.r.str) ||
          cluster[0].r.transform[4] - anchor.r.transform[4] - anchor.r.width < -em * 0.01 ||
          cluster[0].r.transform[4] - anchor.r.transform[4] - anchor.r.width > em * 0.08
        )
          return
        scriptGroups.push(cluster)
      }
    }
    const leading = baselines[0] - baselines[1]
    if (
      scriptGroups.length < 2 ||
      leading < em * 1.05 ||
      leading > em * 1.2 ||
      baselines.some((b, i) => i && Math.abs(baselines[i - 1] - b - leading) > em * 0.01)
    )
      return
    const after = packet.records.find((r) => r.index > owned.at(-1).index)
    if (
      !after ||
      after.r.height < em * 1.1 ||
      after.rect[1] - rect[3] < em * 1.5 ||
      after.rect[0] > rect[0] - em * 2 ||
      after.rect[2] < rect[2] ||
      packet.records.some((r) => !owned.includes(r) && hit(rect, r.rect))
    )
      return
    const images = packet.evidence.images.map((p) => p.rect).sort((a, b) => a[0] - b[0]),
      near = (a, b) => Math.abs(a - b) < 1e-4
    if (
      images.length !== 3 ||
      images.some(
        (r, i) =>
          !inside([0, 0, page.width, page.height], r) ||
          !near(r[1], images[0][1]) ||
          !near(r[3], images[0][3]) ||
          !near(r[2] - r[0], images[0][2] - images[0][0]) ||
          r[3] >= first.y ||
          (i && r[0] <= images[i - 1][2])
      )
    )
      return
    const labels = []
    for (let i = 0; i < images.length; i++) {
      const matches = packet.records.filter((r) => r.r.str === `(${String.fromCharCode(97 + i)})`),
        image = images[i]
      if (matches.length !== 1) return
      const r = matches[0],
        h = r.r.height
      if (
        r.index >= owned[0].index ||
        r.rect[1] <= image[3] ||
        r.rect[1] - image[3] > h * 2 ||
        first.y - r.rect[3] < 0 ||
        first.y - r.rect[3] > em * 2 ||
        Math.abs(r.rect[0] + r.rect[2] - image[0] - image[2]) / 2 > h / 8
      )
        return
      labels.push(r)
    }
    if (
      packet.records.some((r) => r.index > labels.at(-1).index && r.index < owned[0].index) ||
      scope.captions.some(
        (c) => c !== scope.figure.caption && c.page === page.pageNumber && hit(c.rect, rect)
      ) ||
      scope.tables.some((r) => hit(r, rect)) ||
      scope.figures.some((f) => f !== scope.figure && f.rect && hit(f.rect, rect))
    )
      return
    const certificate = createNativeFigurePaintCertificate(page, tokens, context),
      paint = nativeFigurePaintCertificateData(certificate, page, tokens, context)
    if (!paint) return
    const glyphs = new Set(owned.flatMap((r) => r.part.map((p) => p.g))),
      pieces = []
    for (const g of glyphs) {
      if (g.rendererSkipped || g.ink[0] >= g.ink[2] || g.ink[1] >= g.ink[3]) continue
      const matches = paint.pieces.filter(
        (p) =>
          p.kind === 'glyph' &&
          p.operationIndex === g.i &&
          p.packetBegin === g.packet.start &&
          p.packetEnd === g.packet.end &&
          p.fontName === g.fontName &&
          p.text === g.text &&
          p.advance.every((n, i) => n === g.advance[i]) &&
          p.rect.every((n, i) => n === g.ink[i])
      )
      if (matches.length !== 1) return
      pieces.push(matches[0])
    }
    if (
      new Set(pieces).size !== pieces.length ||
      paint.pieces.some((p) => !pieces.includes(p) && hit(p.bound ?? p.rect, rect))
    )
      return
    const lines = rows.map((r) => r.text),
      formatted = nativeCaptionOwnedInlineFragments(page, { ...candidate, lines, rect }, rows, [])
    if (!formatted?.lines || formatted.lines.length !== rows.length || !current()) return
    return {
      ...candidate,
      text: joinCaptionLines(formatted.lines, sourceWordSpellings(page.lines.map((l) => l.text))),
      lines: formatted.lines,
      rect,
      sourceItems: owned.map((r) => r.r.sourceItem)
    }
  } catch {
    return
  }
}

// A double-spaced centered caption can have a short final row that the generic
// geometric paragraph gate declines. Recover only a whole native, font-bound
// Source interval with a closed terminal row and an independent following gap.
export function recoverNativeCenteredCaptionTail(candidate, page, tokens, context) {
  try {
    if (
      candidate?.page !== page.pageNumber ||
      candidate.lines?.length !== 1 ||
      candidate.regions ||
      !/^(?:Fig\.?|Figure)\s+[A-Z]?\d+[.:]\s+\p{L}/iu.test(candidate.lines[0]) ||
      /[.!?]$/u.test(candidate.lines[0].trim()) ||
      context?.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      page.invalidGraphicsBounds !== 0
    )
      return
    const packet = nativePageTextPacketInventory(page, tokens, context, true)
    if (!packet) return
    const runs = groupPageLines(page),
      starts = runs.filter(
        (r) =>
          r.text === candidate.lines[0] &&
          [r.x, r.y, r.right, r.bottom].every((n, i) => Math.abs(n - candidate.rect[i]) < 0.02)
      )
    if (starts.length !== 1) return
    const start = starts[0],
      em = start.fontSize,
      center = (start.x + start.right) / 2,
      rows = [start]
    if (!(em > 0) || start.right - start.x < em * 20) return
    const following = runs.filter((r) => r.y > start.y + em * 0.5).sort((a, b) => a.y - b.y)
    let leading
    for (const row of following) {
      const last = rows.at(-1),
        gap = row.y - last.y
      if (
        rows.length >= 4 ||
        gap < em * 1.65 ||
        gap > em * 1.9 ||
        (leading !== undefined && Math.abs(gap - leading) > em * 0.1) ||
        Math.abs((row.x + row.right) / 2 - center) > em * 0.15 ||
        Math.abs(row.fontSize - em) > em * 0.02 ||
        row.x < start.x - em * 0.05 ||
        row.right > start.right + em * 0.05 ||
        captionKind(row.text) ||
        /^Notes?\s*[:.]/iu.test(row.text) ||
        !/^[\p{Ll}(]/u.test(row.text)
      )
        break
      leading ??= gap
      rows.push(row)
      if (/[.!?]$/u.test(row.text.trim())) break
    }
    const last = rows.at(-1)
    if (
      rows.length < 2 ||
      !/[.!?]$/u.test(last.text.trim()) ||
      last.right - last.x >= (start.right - start.x) * 0.85
    )
      return
    const after = following.find((r) => r.y > last.y + em * 0.5)
    if (!after || after.y - last.y < leading * 1.5) return
    const firstRect = [start.x, start.y, start.right, start.bottom],
      rect = [start.x, start.y, start.right, last.bottom],
      inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 0.02 : n <= a[i] + 0.02)),
      hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
    const owned = packet.records.filter((r) => hit(rect, r.rect)).sort((a, b) => a.index - b.index)
    if (
      !owned.length ||
      owned.some((r) => !inside(rect, r.rect)) ||
      packet.records.some(
        (r) => r.index >= owned[0].index && r.index <= owned.at(-1).index && !owned.includes(r)
      )
    )
      return
    const rowOwners = rows.map((row) =>
      owned.filter((r) => hit([row.x, row.y, row.right, row.bottom], r.rect))
    )
    const first = rowOwners[0],
      main = first.find((r) => /[A-Za-z]{3}/u.test(r.r.str))
    if (
      !main ||
      first.some((r) => !inside(firstRect, r.rect)) ||
      rowOwners.some((a) => !a.length) ||
      new Set(rowOwners.flat()).size !== owned.length
    )
      return
    const baselines = []
    for (let n = 0; n < rows.length; n++) {
      const rr = rowOwners[n],
        words = rr.filter((r) => /[A-Za-z]{3}/u.test(r.r.str))
      baselines.push(words[0]?.r.transform[5])
      if (
        !words.length ||
        words.some((r) => r.r.fontName !== main.r.fontName || Math.abs(r.r.height - em) > 0.02) ||
        rr.some(
          (r) =>
            r.r.transform[0] <= 0 ||
            r.r.transform[1] !== 0 ||
            r.r.transform[2] !== 0 ||
            r.r.transform[3] !== r.r.height ||
            r.r.height < em * 0.6 ||
            r.r.height > em * 1.02 ||
            r.r.sourceItem?.pageNumber !== page.pageNumber ||
            r.r.sourceItem.index !== r.index ||
            r.r.sourceItem.text !== r.r.str
        )
      )
        return
    }
    const nativeLeading = baselines[0] - baselines[1]
    if (
      nativeLeading < em * 1.65 ||
      nativeLeading > em * 1.9 ||
      baselines.some((b, i) => i && Math.abs(baselines[i - 1] - b - nativeLeading) > em * 0.01)
    )
      return
    const above = packet.evidence.images
      .flatMap((p) => {
        const g = page.graphicsBounds.find(
          (g) =>
            g.kind === 'image' &&
            g.operationIndex === p.operationIndex &&
            g.normalizedRect?.length === 4 &&
            g.normalizedRect.every(Number.isFinite)
        )
        if (!g) return []
        const r = g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
        return inside(r, p.rect) ? [{ g, r: p.rect }] : []
      })
      .filter(
        ({ r }) =>
          r[3] <= start.y &&
          start.y - r[3] < em * 4 &&
          r[0] >= start.x - em * 2 &&
          r[2] <= start.right + em * 2 &&
          r[2] - r[0] > em * 3 &&
          r[3] - r[1] > em * 3
      )
    if (
      !above.length ||
      Math.max(...above.map((x) => x.r[2])) - Math.min(...above.map((x) => x.r[0])) < em * 10
    )
      return
    return {
      ...candidate,
      lines: rows.map((r) => r.text),
      rect,
      sourceItems: owned.map((r) => r.r.sourceItem)
    }
  } catch {
    return
  }
}

// Resolve the actual shared native font and repeated folio rail before omitting
// one whole source from caption metadata. This never supplies figure/body claims.
export async function recoverNativeFolioCaption({
  candidate,
  page,
  tokens,
  context,
  document,
  figure,
  captions = [],
  tables = [],
  rules = [],
  signal
}) {
  try {
    if (
      !candidate?.lines?.length ||
      context?.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      page.rotation !== 0 ||
      page.renderRotation !== 0 ||
      !document?.getPage
    )
      return
    const retained = retainNativeRecoveryInputs(
      [candidate, page, tokens, context],
      context.viewport
    )
    if (!retained) return
    signal?.throwIfAborted()
    const beforePages = document.numPages,
      beforeFingerprint = document.fingerprints?.[0],
      raw = context.content.items,
      target = raw
        .map((r, index) => ({ r, index }))
        .filter(({ r }) => r.str?.trim())
        .at(-1)
    if (
      !target ||
      target.r.str !== String(page.pageNumber) ||
      raw.filter((r) => r.str === target.r.str).length !== 1 ||
      target.r.sourceItem?.pageNumber !== page.pageNumber ||
      target.r.sourceItem.index !== target.index ||
      target.r.sourceItem.text !== target.r.str
    )
      return
    const core = () =>
      nativePageTextPacketInventory(page, tokens, context, true) ??
      nativeTypedPlotPacketInventory(page, figure, captions, tables, rules, tokens, context)
    if (!core()) return
    const fontKeys = [
      'loadedName',
      'missingFile',
      'isType3Font',
      'isInvalidPDFjsFont',
      'systemFontInfo',
      'vertical',
      'ascent',
      'descent'
    ]
    const fontField = (font, key) => {
      let owner = font
      while (owner && !Object.prototype.hasOwnProperty.call(owner, key))
        owner = Object.getPrototypeOf(owner)
      const d = owner && Object.getOwnPropertyDescriptor(owner, key)
      return [
        owner,
        ...['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].map((n) => d?.[n])
      ]
    }
    let activeEpochCurrent
    const peers = []
    for (
      let number = Math.max(1, page.pageNumber - 4);
      number <= Math.min(document.numPages, page.pageNumber + 4);
      number++
    ) {
      signal?.throwIfAborted()
      const nativePage = await document.getPage(number),
        content = await nativePage.getTextContent(),
        viewport = nativePage.getViewport({ scale: 1 }),
        entries = content.items.flatMap((r, index) => (r.str?.trim() ? [{ r, index }] : [])),
        last = entries.at(-1)
      if (
        !last ||
        last.r.str !== String(number) ||
        entries.filter((e) => e.r.str === String(number)).length !== 1
      )
        continue
      if (number === page.pageNumber) {
        // Render and producer documents have independent PDF.js font IDs. Bind
        // the complete ordered native page; never replace either Source epoch.
        const old = context.content,
          forward = new Map(),
          reverse = new Map(),
          fontEpoch = []
        if (old.items.length !== content.items.length) return
        for (let index = 0; index < old.items.length; index++) {
          const a = old.items[index],
            b = content.items[index]
          if (
            ['str', 'dir', 'width', 'height', 'hasEOL'].some((key) => !Object.is(a[key], b[key])) ||
            !Array.isArray(a.transform) ||
            !Array.isArray(b.transform) ||
            a.transform.length !== 6 ||
            b.transform.length !== 6 ||
            a.transform.some((n, i) => !Object.is(n, b.transform[i]))
          )
            return
          if (typeof a.fontName !== 'string' || typeof b.fontName !== 'string') return
          if (
            (forward.has(a.fontName) && forward.get(a.fontName) !== b.fontName) ||
            (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
          )
            return
          forward.set(a.fontName, b.fontName)
          reverse.set(b.fontName, a.fontName)
          const x = old.styles[a.fontName],
            y = content.styles[b.fontName]
          if (
            !x ||
            !y ||
            Object.keys(x).sort().join('|') !== Object.keys(y).sort().join('|') ||
            Object.keys(x).some((key) => !Object.is(x[key], y[key]))
          )
            return
        }
        await nativePage.getOperatorList()
        signal?.throwIfAborted()
        for (const name of reverse.keys()) {
          if (!nativePage.commonObjs.has(name)) return
          const font = nativePage.commonObjs.get(name),
            style = content.styles[name],
            matrix = font.fontMatrix
          if (
            !font ||
            font.loadedName !== name ||
            font.missingFile !== false ||
            font.isInvalidPDFjsFont !== false ||
            font.systemFontInfo !== null ||
            typeof font.isType3Font !== 'boolean' ||
            font.ascent !== style.ascent ||
            font.descent !== style.descent ||
            font.vertical !== style.vertical ||
            !Number.isFinite(style.ascent) ||
            !Number.isFinite(style.descent) ||
            !(Array.isArray(matrix) || ArrayBuffer.isView(matrix)) ||
            matrix.length !== 6 ||
            !Array.from(matrix).every(Number.isFinite)
          )
            return
          const values = fontKeys.map((key) => font[key]),
            matrixValues = Array.from(matrix),
            descriptors = [...fontKeys, 'fontMatrix'].map((key) => fontField(font, key))
          fontEpoch.push(() => {
            const current = font.fontMatrix
            return (
              nativePage.commonObjs.get(name) === font &&
              [...fontKeys, 'fontMatrix'].every((key, index) =>
                fontField(font, key).every((n, i) => Object.is(n, descriptors[index][i]))
              ) &&
              fontKeys.every((key, index) => Object.is(font[key], values[index])) &&
              (Array.isArray(current) || ArrayBuffer.isView(current)) &&
              current.length === 6 &&
              Array.from(current).every((n, i) => Object.is(n, matrixValues[i]))
            )
          })
        }
        const sourceEpoch = retainNativeRecoveryInputs([content], viewport)
        if (!sourceEpoch || !retained()) return
        activeEpochCurrent = () => sourceEpoch() && fontEpoch.every((check) => check())
      }
      const r = last.r,
        style = content.styles[r.fontName]
      if (!nativePage.commonObjs.has(r.fontName)) await nativePage.getOperatorList()
      const font = nativePage.commonObjs.get(r.fontName)
      if (
        nativePage.rotate !== 0 ||
        !font ||
        font.loadedName !== r.fontName ||
        font.missingFile !== false ||
        font.isType3Font !== false ||
        font.isInvalidPDFjsFont !== false ||
        font.systemFontInfo !== null ||
        font.vertical !== false ||
        style?.vertical !== false ||
        font.ascent !== style.ascent ||
        font.descent !== style.descent ||
        !(font.ascent > 0 && font.ascent <= 1 && font.descent >= -1 && font.descent <= 0) ||
        r.dir !== 'ltr' ||
        !Array.isArray(r.transform) ||
        r.transform.length !== 6 ||
        ![...r.transform, r.height, r.width].every(Number.isFinite) ||
        r.transform[0] !== r.height ||
        r.transform[3] !== r.height ||
        r.transform[1] !== 0 ||
        r.transform[2] !== 0 ||
        r.width <= 0 ||
        r.width > r.height * 3 ||
        r.transform[5] < r.height * 2 ||
        r.transform[5] > viewport.height * 0.3 ||
        Math.abs(r.transform[4] + r.width / 2 - viewport.width / 2) > r.height * 3
      )
        continue
      const clear =
        entries
          .filter((e) => e !== last)
          .every(
            ({ r: o }) =>
              o.transform[1] !== 0 ||
              o.transform[2] !== 0 ||
              o.transform[5] - o.height > r.transform[5] + r.height * 1.5
          ) && entries.some(({ r: o }) => (o.str.match(/[A-Za-z]{2,}/gu)?.length ?? 0) >= 6)
      peers.push({
        number,
        r,
        index: last.index,
        font,
        fontState: fontKeys.map((key) => font[key]),
        style,
        viewport,
        clear,
        center: r.transform[4] + r.width / 2,
        nativePage,
        seal: retainNativeRecoveryInputs([content], viewport)
      })
    }
    const own = peers.find((p) => p.number === page.pageNumber)
    if (!own) return
    const h = own.r.height,
      matching = peers.filter(
        (p) =>
          p.font === own.font &&
          p.viewport.width === own.viewport.width &&
          p.viewport.height === own.viewport.height &&
          p.r.height === h &&
          Math.abs(p.r.transform[5] - own.r.transform[5]) < h * 0.002
      )
    const lanes = [0, 1].map((n) => matching.filter((p) => p.number % 2 === n))
    if (
      matching.length < 5 ||
      matching.filter((p) => p.clear).length < 3 ||
      !matching.some(
        (p) =>
          matching.some((q) => q.number === p.number + 1) &&
          matching.some((q) => q.number === p.number + 2)
      ) ||
      lanes.some(
        (l) => l.length < 2 || l.some((p) => Math.abs(p.center - l[0].center) > h * 0.002)
      ) ||
      Math.abs(lanes[0][0].center + lanes[1][0].center - page.width) > h * 0.01 ||
      !retained() ||
      !activeEpochCurrent?.() ||
      document.numPages !== beforePages ||
      document.fingerprints?.[0] !== beforeFingerprint ||
      matching.some(
        (p) =>
          !p.seal?.() ||
          p.nativePage.commonObjs.get(p.r.fontName) !== own.font ||
          fontKeys.some((key, index) => !Object.is(p.font[key], p.fontState[index]))
      ) ||
      !core()
    )
      return
    const packet = core(),
      record = packet.records.find((r) => r.index === target.index && r.r === target.r)
    if (!record) return
    const folioLines = page.lines.filter(
      (l) =>
        l.text === target.r.str &&
        [l.x, l.y, l.x + l.width, l.y + l.height].every(
          (n, i) => Math.abs(n - record.rect[i]) < 0.02
        )
    )
    if (folioLines.length !== 1) return
    const folio = folioLines[0],
      origins = new Map(),
      oldRuns = groupPageLines(page, rules, origins),
      owners = oldRuns.filter(
        (r) => origins.get(r).includes(folio) && candidate.lines.includes(r.text)
      )
    if (owners.length !== 1) return
    const old = owners[0],
      parts = origins.get(old).filter((p) => p !== folio),
      cleaned = { ...page, lines: page.lines.filter((l) => l !== folio) },
      newOrigins = new Map(),
      newRuns = groupPageLines(cleaned, rules, newOrigins),
      replacement = parts.length
        ? newRuns.filter(
            (r) =>
              newOrigins.get(r).length === parts.length &&
              newOrigins.get(r).every((p) => parts.includes(p))
          )
        : []
    if (
      (parts.length && replacement.length !== 1) ||
      candidate.lines.filter((l) => l === old.text).length !== 1
    )
      return
    const lines = candidate.lines.flatMap((l) =>
      l === old.text ? replacement.map((r) => r.text) : [l]
    )
    if (
      !lines.length ||
      JSON.stringify(lines) === JSON.stringify(candidate.lines) ||
      !retained() ||
      !activeEpochCurrent?.()
    )
      return
    signal?.throwIfAborted()
    return {
      ...candidate,
      lines,
      ...(candidate.sourceItems
        ? { sourceItems: candidate.sourceItems.filter((s) => s !== target.r.sourceItem) }
        : {})
    }
  } catch {
    signal?.throwIfAborted()
    return
  }
}

// This optional recovery publishes only figure pixels and literal captions.
// A note or panel description never becomes a Source owner through this path.
const separatedFigureProofs = new WeakMap()
export function recoverNativeSeparatedFigureBodies(
  page,
  captions,
  tokens,
  context,
  exclusions = [],
  figures = []
) {
  try {
    const own = nativeRecoveryOwnValues(context)
    if (!own) return []
    const current = retainNativeRecoveryInputs(
      [page, captions, tokens, context, exclusions, figures],
      own.viewport
    )
    if (
      !current ||
      ![captions, tokens, exclusions, figures].every(Array.isArray) ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      context.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      !exclusions.every(separatedValid)
    )
      return []
    const sourceCurrent = retainNativeRecoveryInputs([page, tokens, context], own.viewport)
    if (!sourceCurrent) return []
    const packet = nativePageTextPacketInventory(page, tokens, context, true)
    if (!packet) return []
    const rows = groupPageLines(page).sort((a, b) => a.y - b.y || a.x - b.x)
    const cover = (selected) => {
      const records = []
      for (const line of selected) {
        const matches = packet.records
          .filter(
            (r) =>
              r.r.str.trim() &&
              r.rect[0] >= line.x - 0.05 &&
              r.rect[2] <= line.right + 0.05 &&
              r.rect[1] >= line.y - 0.05 &&
              r.rect[3] <= line.bottom + 0.05
          )
          .sort((a, b) => a.rect[0] - b.rect[0] || a.index - b.index)
        const literal = page.lines
          .filter(
            (r) =>
              r.x >= line.x - 0.05 &&
              r.x + r.width <= line.right + 0.05 &&
              r.y >= line.y - 0.05 &&
              r.y + r.height <= line.bottom + 0.05
          )
          .sort((a, b) => a.x - b.x || a.y - b.y)
        // Grouped rows may display a proven raised digit as a superscript.
        // Compare the untouched physical native fragments, never normalize Source.
        if (
          !literal.length ||
          !matches.length ||
          separatedCompact(matches.map((r) => r.r.str).join('')) !==
            separatedCompact(literal.map((r) => r.text).join(''))
        )
          return
        for (const r of matches) {
          if (r.part.some((z) => z.g.rendererSkipped && z.g.text.trim())) return
          const style = context.content.styles[r.r.fontName],
            source = r.r.sourceItem
          if (
            !style ||
            style.vertical ||
            !Number.isFinite(style.ascent) ||
            !Number.isFinite(style.descent) ||
            style.ascent <= 0 ||
            style.descent > 0 ||
            r.r.dir !== 'ltr' ||
            !source ||
            source.pageNumber !== page.pageNumber ||
            source.index !== r.index ||
            source.text !== r.r.str ||
            tokens.filter(
              (t) =>
                t.sourceItem?.pageNumber === page.pageNumber &&
                t.sourceItem.index === r.index &&
                t.sourceItem.text === r.r.str
            ).length !== 1
          )
            return
        }
        records.push(...matches)
      }
      return records.length === new Set(records).size ? records : undefined
    }
    const existing = captions.filter((c) => c.page === page.pageNumber)
    const candidates = [...existing.filter((c) => captionKind(c.lines?.[0] ?? '') === 'figure')]
    const recovered = new Set()
    // A native label in a separate font, a closed small-type paragraph and
    // a complete vector body jointly distinguish a caption from a body reference.
    for (const head of rows) {
      const label = /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+(?=\p{Lu})/u.exec(head.text)
      if (!label || captionKind(head.text)) continue
      const overlapping = existing.filter((c) =>
        separatedHit(c.rect, [head.x, head.y, head.right, head.bottom])
      )
      if (overlapping.length > 1) continue
      const labelText = label[0].trim()
      const first = cover([head])
      if (
        !first ||
        first.length < 2 ||
        first[0].r.str !== labelText ||
        first[0].r.fontName === first[1].r.fontName ||
        first[0].r.height !== head.fontSize ||
        Math.abs(first[0].rect[0] - head.x) > 0.05
      )
        continue
      const block = [head]
      for (const line of rows.filter((r) => r.y > head.y)) {
        const previous = block.at(-1)
        if (
          line.y - previous.y > head.fontSize * 1.6 ||
          Math.abs(line.fontSize - head.fontSize) > 0.05 ||
          Math.abs(line.x - head.x) > 0.1 ||
          line.right > head.right + 0.1 ||
          /^(?:Fig\.?|Figure|Table)\s+[A-Z]?\d/u.test(line.text)
        )
          break
        block.push(line)
      }
      if (
        block.length < 2 ||
        block.length > 16 ||
        !/[.!?]$/u.test(block.at(-1).text) ||
        !cover(block)
      )
        continue
      const literalCaption = {
        page: page.pageNumber,
        lines: block.map((r) => r.text),
        rect: [head.x, head.y, Math.max(...block.map((r) => r.right)), block.at(-1).bottom]
      }
      if (overlapping.length && JSON.stringify(overlapping[0]) !== JSON.stringify(literalCaption))
        continue
      const caption = overlapping[0] ?? literalCaption
      candidates.push(caption)
      recovered.add(caption)
    }
    const result = []
    for (const caption of candidates) {
      if (
        !separatedValid(caption.rect) ||
        figures.some(
          (f) => f.rect && (f.caption === caption || f.caption?.lines?.[0] === caption.lines[0])
        )
      )
        continue
      const capRows = rows.filter(
        (r) =>
          r.y >= caption.rect[1] - 0.05 &&
          r.bottom <= caption.rect[3] + 0.05 &&
          r.x >= caption.rect[0] - 0.05 &&
          r.right <= caption.rect[2] + 0.05
      )
      const capRecords = cover(capRows)
      if (
        !capRows.length ||
        separatedCompact(capRows.map((r) => r.text).join('')) !==
          separatedCompact(caption.lines.join('')) ||
        !capRecords
      )
        continue
      let rect, kind
      let paintCurrent = () => true
      if (!recovered.has(caption) && packet.evidence.images.length) {
        if (packet.evidence.images.length !== 1) continue
        const image = packet.evidence.images[0]
        if (
          !separatedValid(image.rect) ||
          image.rect[3] >= caption.rect[1] ||
          (image.rect[2] - image.rect[0]) * (image.rect[3] - image.rect[1]) <
            page.width * page.height * 0.05
        )
          continue
        const native = context.graphicsBounds.filter(
          (g) => g.kind === 'image' && g.operationIndex === image.operationIndex
        )
        if (native.length !== 1 || !/^[a-f0-9]{64}$/u.test(native[0].imageHash ?? '')) continue
        const notes = rows.filter(
          (r) =>
            r.y >= image.rect[3] - 0.05 &&
            r.bottom <= caption.rect[1] &&
            r.x < image.rect[2] &&
            r.right > image.rect[0]
        )
        if (
          !notes.length ||
          notes.length > 12 ||
          !/^Notes?:\s*\S/u.test(notes[0].text) ||
          !/[.!?]$/u.test(notes.at(-1).text) ||
          notes[0].fontSize >= capRows[0].fontSize * 0.9 ||
          notes[0].y - image.rect[3] > notes[0].fontSize * 2 ||
          caption.rect[1] - notes.at(-1).bottom > notes[0].fontSize * 2 ||
          notes.some(
            (r, i) =>
              Math.abs(r.fontSize - notes[0].fontSize) > 0.05 ||
              Math.abs(r.x - notes[0].x) > 0.1 ||
              r.x < image.rect[0] - 0.1 ||
              r.right > image.rect[2] + 0.1 ||
              (i &&
                (r.bottom - notes[i - 1].bottom < r.fontSize ||
                  r.bottom - notes[i - 1].bottom > r.fontSize * 1.6))
          ) ||
          Math.abs(
            image.rect[0] + image.rect[2] - notes[0].x - Math.max(...notes.map((r) => r.right))
          ) >
            notes[0].fontSize * 2 ||
          !cover(notes)
        )
          continue
        if (
          packet.records.some(
            (r) =>
              separatedHit(r.rect, image.rect) ||
              r.part.some((z) => separatedHit(z.g.ink, image.rect))
          )
        )
          continue
        rect = [...image.rect]
        kind = 'native-raster-before-explicit-notes'
      } else {
        if (
          !recovered.has(caption) &&
          existing.filter((c) => captionKind(c.lines?.[0] ?? '') === 'figure').length !== 1
        )
          continue
        if (packet.evidence.images.length) continue
        const handle = createNativeFigurePaintCertificate(page, tokens, context)
        const data = nativeFigurePaintCertificateData(handle, page, tokens, context)
        if (!data) continue
        const forms = data.scopes.filter(
          (s) =>
            s.op === OPS.paintFormXObjectBegin &&
            !data.scopes.some(
              (p) => p.op === OPS.paintFormXObjectBegin && p.begin < s.begin && p.end > s.end
            )
        )
        if (forms.length !== 1) continue
        const scope = forms[0]
        const member = (i) => i > scope.begin && i < scope.end
        const visible = (piece) => {
          const r = piece.paintClip
            ? [
                Math.max(piece.rect[0], piece.paintClip[0]),
                Math.max(piece.rect[1], piece.paintClip[1]),
                Math.min(piece.rect[2], piece.paintClip[2]),
                Math.min(piece.rect[3], piece.paintClip[3])
              ]
            : piece.rect
          return separatedValid(r) ? r : undefined
        }
        const members = data.pieces.filter((p) => member(p.operationIndex))
        if (
          members.some((p) => !['glyph', 'path'].includes(p.kind)) ||
          members.filter((p) => p.kind === 'path').length < 3 ||
          members.filter((p) => p.kind === 'glyph').length < 4
        )
          continue
        const body = packet.records.filter((r) => r.part.some((z) => member(z.g.i)))
        if (!body.length || body.some((r) => r.part.some((z) => !member(z.g.i)))) continue
        const bounds = members.map(visible).filter(separatedValid)
        if (bounds.length !== members.length) continue
        rect = separatedUnion([
          ...bounds,
          ...body.flatMap((r) => [r.rect, ...r.part.map((z) => z.g.ink).filter(separatedValid)])
        ])
        if (
          rect[3] >= caption.rect[1] ||
          caption.rect[1] - rect[3] > capRows[0].fontSize * 3 ||
          rect[2] - rect[0] < page.width * 0.4 ||
          rect[3] - rect[1] < page.height * 0.08 ||
          data.pieces.some((p) => !member(p.operationIndex) && separatedHit(visible(p), rect))
        )
          continue
        paintCurrent = () =>
          nativeFigurePaintCertificateData(handle, page, tokens, context) === data
        kind = 'native-distinct-font-closed-form-caption'
      }
      if (
        !separatedValid(rect) ||
        rect[0] < 0 ||
        rect[1] < 0 ||
        rect[2] > page.width ||
        rect[3] > caption.rect[1] ||
        exclusions.some((r) => separatedHit(r, rect)) ||
        existing.some((c) => c !== caption && separatedHit(c.rect, rect)) ||
        figures.some((f) => f.rect && separatedHit(f.rect, rect))
      )
        continue
      if (capRecords.some((r) => r.part.some((z) => separatedHit(z.g.ink, rect)))) continue
      const figure = { caption, rect, graphicsCount: 1 }
      const outputCurrent = retainNativeRecoveryInputs([figure])
      if (!outputCurrent || !current()) continue
      separatedFigureProofs.set(figure, {
        page,
        captions,
        tokens,
        context,
        exclusions,
        figures,
        current,
        sourceCurrent,
        paintCurrent,
        outputCurrent,
        kind
      })
      result.push(figure)
    }
    return result
  } catch {
    return []
  }
}
export function nativeSeparatedFigureRecoveryCurrent(
  figure,
  page,
  captions,
  tokens,
  context,
  exclusions,
  figures
) {
  try {
    const p = separatedFigureProofs.get(figure)
    return (
      !!p &&
      p.page === page &&
      p.captions === captions &&
      p.tokens === tokens &&
      p.context === context &&
      p.exclusions === exclusions &&
      p.figures === figures &&
      p.current() &&
      p.sourceCurrent() &&
      p.paintCurrent() &&
      p.outputCurrent()
    )
  } catch {
    return false
  }
}
const separatedCompact = (s) => s.replace(/\s/gu, '')
const separatedValid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const separatedHit = (a, b) =>
  separatedValid(a) && separatedValid(b) && a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const separatedUnion = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]

// Metadata restoration may replace caption arrays. A caller re-proving that
// metadata must still retain this original Source identity across every await.
// This predicate alone authorizes no caption, crop, cell or navigation item.
export function nativeSeparatedFigureRecoverySourcesCurrent(figure, page, tokens, context) {
  try {
    const p = separatedFigureProofs.get(figure)
    return (
      !!p &&
      p.page === page &&
      p.tokens === tokens &&
      p.context === context &&
      p.sourceCurrent() &&
      p.paintCurrent()
    )
  } catch {
    return false
  }
}

// This proves an optional metadata omission, never pixel or Source ownership.
export function nativeOrdinaryBodyReferenceMetadata(figure, page, captions, figures, native) {
  try {
    const finite = (r, n) => Array.isArray(r) && r.length === n && r.every(Number.isFinite),
      inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6)),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      union = (rs) => [
        Math.min(...rs.map((r) => r[0])),
        Math.min(...rs.map((r) => r[1])),
        Math.max(...rs.map((r) => r[2])),
        Math.max(...rs.map((r) => r[3]))
      ],
      same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    if (
      !figure ||
      figure.region != null ||
      figure.thumbnail != null ||
      figure.sourceItems?.length ||
      Object.keys(figure).some(
        (k) =>
          ![
            'id',
            'page',
            'caption',
            'region',
            'thumbnail',
            'issue',
            'graphicsCount',
            'sourceItems'
          ].includes(k)
      ) ||
      figure.page !== page?.pageNumber ||
      native?.pageNumber !== page.pageNumber ||
      page.rotation !== 0 ||
      page.renderRotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      !Array.isArray(page.lines) ||
      page.lines.length > 4096 ||
      !Array.isArray(page.graphicsBounds) ||
      !Array.isArray(captions) ||
      !Array.isArray(figures) ||
      !figures.includes(figure) ||
      !finite(native.viewport?.transform, 6) ||
      !same(native.viewport.transform, [1, 0, 0, -1, 0, page.height]) ||
      native.viewport.width !== page.width ||
      native.viewport.height !== page.height ||
      !Array.isArray(native.content?.items)
    )
      return
    const matches = captions.filter(
      (c) =>
        c.page === figure.page &&
        same(c.lines, figure.caption?.lines) &&
        same(c.rect, figure.caption?.rect)
    )
    if (matches.length !== 1) return
    const candidate = matches[0],
      reference =
        /^(?:Figure|Fig\.)\s+([A-Z]?[1-9]\d*[a-z]?)\s+\p{Ll}{3,}s\s+(?:this|the|these|those|our|a|an)\s+\p{L}/u.exec(
          candidate.lines?.[0] ?? ''
        )
    if (
      !reference ||
      !finite(candidate.rect, 4) ||
      candidate.lines.length < 3 ||
      candidate.lines.length > 16 ||
      !/[.!?]$/u.test(candidate.lines.at(-1))
    )
      return
    const current = retainNativeRecoveryInputs(
      [figure, page, captions, figures, native],
      native.viewport
    )
    if (!current) return
    const tokens = native.content.items
        .filter((r) => r.str?.trim())
        .map((r) => tableTextToken(r, native.viewport, 0)),
      packet = nativePageTextPacketInventory(page, tokens, native, true)
    if (!packet || packet.records.length > 4096 || packet.evidence.paths.size > 4096) return
    const records = packet.records.filter((r) => inside(candidate.rect, r.rect)),
      first = records[0],
      last = records.at(-1),
      em = first?.r.height,
      font = first?.r.fontName,
      style = native.content.styles[font]
    if (
      !first ||
      records.length < candidate.lines.length ||
      records.length > 128 ||
      !(em > 0) ||
      !first.r.str.startsWith(reference[0]) ||
      !/[.!?]$/u.test(last.r.str) ||
      records.some(
        (r) =>
          r.r.fontName !== font ||
          r.r.height !== em ||
          !finite(r.r.transform, 6) ||
          r.r.transform[1] !== 0 ||
          r.r.transform[2] !== 0 ||
          r.r.transform[0] !== em ||
          r.r.transform[3] !== em
      ) ||
      !Number.isFinite(style?.ascent) ||
      !Number.isFinite(style?.descent) ||
      style.vertical !== false ||
      style.ascent <= 0 ||
      style.descent > 0 ||
      packet.records.filter((r) => r.index >= first.index && r.index <= last.index).length !==
        records.length
    )
      return
    const runs = groupPageLines(page).sort((a, b) => a.y - b.y || a.x - b.x),
      rowRect = (r) => [r.x, r.y, r.right, r.bottom],
      owned = runs.filter((r) => inside(candidate.rect, rowRect(r)))
    if (
      owned.length !== candidate.lines.length ||
      owned.some((r, i) => r.text !== candidate.lines[i] || Math.abs(r.fontSize - em) > em * 0.015)
    )
      return
    const pitch = owned[1].y - owned[0].y,
      left = Math.min(...owned.slice(1).map((r) => r.x)),
      indent = owned[0].x - left
    if (
      pitch < em ||
      pitch > em * 1.5 ||
      indent < em / 2 ||
      indent > em * 3 ||
      owned.some(
        (r, i) =>
          i &&
          (Math.abs(r.y - owned[i - 1].y - pitch) > em * 0.02 || Math.abs(r.x - left) > em * 0.02)
      )
    )
      return
    const trueCaps = captions.filter(
      (c) =>
        c !== candidate &&
        c.page === figure.page &&
        finite(c.rect, 4) &&
        c.rect[3] < candidate.rect[1] &&
        /^(?:Figure|Fig\.)\s+([A-Z]?[1-9]\d*[a-z]?)[.:]\s/u.exec(c.lines?.[0] ?? '')?.[1] ===
          reference[1]
    )
    if (trueCaps.length !== 1) return
    const completeFontStyle = (value) =>
      Number.isFinite(value?.ascent) && Number.isFinite(value?.descent) && value.vertical === false
    const trueCaption = trueCaps[0],
      truePeers = figures.filter(
        (f) =>
          f !== figure &&
          f.page === figure.page &&
          finite(f.region, 4) &&
          typeof f.thumbnail === 'string' &&
          same(f.caption?.lines, trueCaption.lines) &&
          same(f.caption?.rect, trueCaption.rect)
      ),
      markers = packet.records.filter(
        (r) =>
          r.index < first.index &&
          inside(trueCaption.rect, r.rect) &&
          r.r.str ===
            /^(?:(?:Figure|Fig\.)\s+[A-Z]?[1-9]\d*[a-z]?[.:])\s*/u
              .exec(trueCaption.lines[0])?.[0]
              ?.trim()
      ),
      marker = markers[0]
    if (
      truePeers.length !== 1 ||
      markers.length !== 1 ||
      !completeFontStyle(native.content.styles[marker?.r.fontName]) ||
      marker.r.fontName === font ||
      native.content.styles[marker.r.fontName]?.ascent <= style.ascent ||
      native.content.styles[marker.r.fontName]?.descent > style.descent ||
      first.rect[1] - trueCaption.rect[3] > em * 4
    )
      return
    const capRows = runs.filter((r) => inside(trueCaption.rect, rowRect(r)))
    if (
      !same(
        capRows.map((r) => r.text),
        trueCaption.lines
      )
    )
      return
    const next = runs.find((r) => r.y > owned.at(-1).bottom),
      heading = /^(?:[IVX]+|\d+(?:\.\d+)*)\s+\p{Lu}/u
    if (
      !next ||
      !heading.test(next.text) ||
      next.y - owned.at(-1).bottom > em * 4 ||
      next.fontSize < em ||
      !packet.records.some(
        (r) =>
          r.index > last.index &&
          r.r.fontName === marker.r.fontName &&
          completeFontStyle(native.content.styles[r.r.fontName]) &&
          inside(rowRect(next), r.rect)
      )
    )
      return
    const glyphs = [...new Set(records.flatMap((r) => r.part.map((p) => p.g)))]
    if (
      glyphs.some(
        (g) =>
          g.text.trim() &&
          (g.rendererSkipped || !finite(g.ink, 4) || g.ink[0] >= g.ink[2] || g.ink[1] >= g.ink[3])
      )
    )
      return
    const envelope = union([
      ...records.map((r) => r.rect),
      ...glyphs
        .filter((g) => !g.rendererSkipped && g.ink[0] < g.ink[2] && g.ink[1] < g.ink[3])
        .map((g) => g.ink)
    ])
    if (
      !inside([0, 0, page.width, page.height], envelope) ||
      packet.records.some(
        (r) =>
          !records.includes(r) &&
          (hit(envelope, r.rect) ||
            r.part.some(({ g }) => !g.rendererSkipped && hit(envelope, g.ink)))
      ) ||
      page.graphicsBounds.some(
        (g) =>
          !finite(g.normalizedRect, 4) ||
          hit(
            envelope,
            g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
          )
      ) ||
      !current()
    )
      return
    return { current }
  } catch {
    return
  }
}

// This omission has no pixel or Source authority. A complete preceding body
// can overhang the next line's advance cell while remaining above every ink
// outline on that line. Preserve all original bounds and prove those domains
// separately; the local metadata helper and its ordinary hit guard stay strict.
export function nativeCrossPageOrdinaryBodyReferenceMetadata(
  figure,
  page,
  captions,
  figures,
  native,
  previousFrame
) {
  try {
    const input = nativeRecoveryOwnValues(figure),
      own = nativeRecoveryOwnValues(native),
      priorFrame = nativeRecoveryOwnValues(previousFrame),
      priorPage = priorFrame?.pageGeometry,
      priorNative = priorFrame?.context,
      priorOwn = nativeRecoveryOwnValues(priorNative),
      finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
      horizontal = (r) =>
        finite(r.transform, 6) &&
        r.transform[0] > 0 &&
        r.transform[1] === 0 &&
        r.transform[2] === 0 &&
        r.transform[3] === r.height,
      valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3],
      same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
      compact = (s) => s.replace(/\s/gu, ''),
      inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6)),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      positive = (g) => !g.rendererSkipped && valid(g.ink),
      rowRect = (r) => [r.x, r.y, r.right, r.bottom],
      ordinal = (s) => /^(?:Figure|Fig\.)\s+([A-Z]?[1-9]\d*[a-z]?)[.:]\s/u.exec(s)?.[1],
      heading = /^(?:\d+(?:\.\d+)*)\s+\p{Lu}/u
    if (
      !input ||
      !own ||
      !priorOwn ||
      !priorPage ||
      !Number.isSafeInteger(page?.pageNumber) ||
      priorPage.pageNumber !== page.pageNumber - 1 ||
      priorNative.pageNumber !== priorPage.pageNumber ||
      native.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(own.sourceSha256 ?? '') ||
      own.sourceSha256 !== priorOwn.sourceSha256 ||
      figure.page !== page.pageNumber ||
      figure.region != null ||
      figure.thumbnail != null ||
      figure.sourceItems?.length ||
      Object.keys(figure).some(
        (k) =>
          ![
            'id',
            'page',
            'caption',
            'region',
            'thumbnail',
            'issue',
            'graphicsCount',
            'sourceItems'
          ].includes(k)
      ) ||
      ![captions, figures].every(Array.isArray) ||
      !figures.includes(figure)
    )
      return
    const current = retainNativeRecoveryInputs(
      [figure, page, captions, figures, native, priorPage, priorNative],
      native.viewport,
      priorNative.viewport
    )
    if (!current) return
    const sourceCurrent = () => {
      const frame = nativeRecoveryOwnValues(previousFrame)
      return frame?.pageGeometry === priorPage && frame.context === priorNative && current()
    }
    const matches = captions.filter(
      (c) =>
        c.page === figure.page &&
        same(c.lines, figure.caption?.lines) &&
        same(c.rect, figure.caption?.rect)
    )
    if (matches.length !== 1) return
    const candidate = matches[0],
      reference =
        /^(?:Figure|Fig\.)\s+([A-Z]?[1-9]\d*[a-z]?)\s+\p{Ll}{3,}s\s+(?:this|the|these|those|our|a|an)\s+\p{L}/u.exec(
          candidate.lines?.[0] ?? ''
        )
    if (
      !reference ||
      !valid(candidate.rect) ||
      candidate.lines.length < 3 ||
      candidate.lines.length > 16 ||
      !/[.!?]$/u.test(candidate.lines.at(-1))
    )
      return
    const normalized = (r) => valid(r) && r.every((v) => v >= 0 && v <= 1),
      parents = figures.filter(
        (f) =>
          f !== figure &&
          normalized(f.region) &&
          typeof f.thumbnail === 'string' &&
          f.thumbnail.length &&
          ordinal(f.caption?.lines?.[0]) === reference[1]
      ),
      parentCaptions = captions.filter((c) => ordinal(c.lines?.[0]) === reference[1])
    if (
      parents.length !== 1 ||
      parentCaptions.length !== 1 ||
      parents[0].page !== priorPage.pageNumber ||
      parentCaptions[0].page !== priorPage.pageNumber ||
      !same(parents[0].caption.lines, parentCaptions[0].lines) ||
      !same(parents[0].caption.rect, parentCaptions[0].rect)
    )
      return
    const frame = (geometry, context) => {
        if (
          geometry.rotation !== 0 ||
          geometry.renderRotation !== 0 ||
          geometry.invalidGraphicsBounds !== 0 ||
          !Array.isArray(geometry.lines) ||
          geometry.lines.length > 4096 ||
          !same(context.viewport?.transform, [1, 0, 0, -1, 0, geometry.height])
        )
          return
        const tokens = context.content.items
            .filter((r) => r.str?.trim())
            .map((r) => tableTextToken(r, context.viewport, 0)),
          packet = nativePageTextPacketInventory(geometry, tokens, context, true)
        if (!packet || packet.records.length > 4096 || packet.evidence.paths.size > 4096) return
        const owner = new Map()
        for (const r of packet.records) {
          const glyphs = [...new Set(r.part.map((z) => z.g))],
            advances = [
              Math.min(...glyphs.map((g) => g.advance[0])),
              Math.min(...glyphs.map((g) => g.advance[1])),
              Math.max(...glyphs.map((g) => g.advance[2])),
              Math.max(...glyphs.map((g) => g.advance[3]))
            ],
            style = context.content.styles[r.r.fontName]
          if (
            !Number.isFinite(style?.ascent) ||
            !Number.isFinite(style.descent) ||
            style.ascent <= 0 ||
            style.descent > 0 ||
            style.vertical !== false ||
            advances.some((v, i) => Math.abs(v - r.rect[i]) > 0.02)
          )
            return
          for (const g of glyphs) {
            if (owner.has(g)) return
            owner.set(g, r)
          }
        }
        if (packet.glyphs.some((g) => positive(g) && !owner.has(g))) return
        return {
          ...packet,
          owner,
          runs: groupPageLines(geometry).sort((a, b) => a.y - b.y || a.x - b.x)
        }
      },
      p = frame(page, native),
      q = frame(priorPage, priorNative)
    if (!p || !q) return
    const recordsFor = (packet, rows) =>
        packet.records.filter((r) => rows.some((row) => inside(rowRect(row), r.rect))),
      completeRows = (packet, rows) => {
        if (!rows.length || rows.length > 64) return
        const records = recordsFor(packet, rows)
        if (
          !records.length ||
          packet.records.filter(
            (r) => r.index >= records[0].index && r.index <= records.at(-1).index
          ).length !== records.length ||
          rows.some(
            (row) =>
              compact(
                records
                  .filter((r) => inside(rowRect(row), r.rect))
                  .map((r) => r.r.str)
                  .join(' ')
              ) !== compact(row.text)
          )
        )
          return
        const glyphs = [...new Set(records.flatMap((r) => r.part.map((z) => z.g)))]
        if (
          glyphs.some(
            (g) =>
              !positive(g) ||
              g.textPaint.fillAlpha !== 1 ||
              !/^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor) ||
              /^#ffffff$/iu.test(g.textPaint.fillColor)
          )
        )
          return
        return { records, glyphs }
      },
      bodyRows = p.runs.filter((r) => inside(candidate.rect, rowRect(r))),
      body = completeRows(p, bodyRows)
    if (
      !body ||
      !same(
        bodyRows.map((r) => r.text),
        candidate.lines
      )
    )
      return
    const first = body.records[0],
      em = first.r.height,
      base = first.r.fontName,
      fonts = [...new Set(body.records.map((r) => r.r.fontName))]
    if (
      !(em > 0) ||
      fonts.length !== 2 ||
      !first.r.str.startsWith(reference[0]) ||
      body.records.some((r) => r.r.height !== em || !horizontal(r.r)) ||
      bodyRows.some((r) => Math.abs(r.fontSize - em) > em * 0.015)
    )
      return
    const starts = bodyRows
        .slice(1)
        .map((r) => r.x)
        .sort((a, b) => a - b),
      left = starts[Math.floor(starts.length / 2)],
      right = Math.max(...bodyRows.map((r) => r.right)),
      pitch = bodyRows[1].y - bodyRows[0].y,
      column = (r) =>
        r.x >= candidate.rect[0] - em / 4 && r.x < left + em * 3 && r.right <= right + em
    if (
      bodyRows[0].x - left < em / 2 ||
      bodyRows[0].x - left > em * 3 ||
      pitch < em ||
      pitch > em * 1.5 ||
      bodyRows.some((r, i) => i && Math.abs(r.y - bodyRows[i - 1].y - pitch) > em * 0.02)
    )
      return
    const beforeRows = p.runs.filter(
        (r) => column(r) && r.bottom <= bodyRows[0].y && Math.abs(r.fontSize - em) <= em * 0.015
      ),
      start = beforeRows.findLastIndex((r) => r.x - left >= em / 2 && r.x - left <= em * 3),
      priorRows = start >= 0 ? beforeRows.slice(start) : [],
      next = p.runs.find((r) => column(r) && r.y > bodyRows.at(-1).bottom),
      priorBody = completeRows(p, priorRows),
      nextHeading = next && heading.test(next.text) && completeRows(p, [next])
    if (
      !priorBody ||
      priorRows.length < 2 ||
      !/[.!?]$/u.test(priorRows.at(-1).text) ||
      !nextHeading ||
      next.fontSize <= em * 1.05 ||
      next.y - bodyRows.at(-1).bottom > em * 4 ||
      priorRows.at(-1).y + pitch < bodyRows[0].y - em * 0.02 ||
      priorBody.records.some(
        (r) => r.r.height !== em || !horizontal(r.r) || !fonts.includes(r.r.fontName)
      )
    )
      return
    const afterRows = p.runs.filter(
        (r) => column(r) && r.y > next.bottom && Math.abs(r.fontSize - em) <= em * 0.015
      ),
      after = completeRows(p, afterRows),
      accent = fonts.find((f) => f !== base),
      styled = body.records.filter((r) => r.r.fontName === accent),
      repeatedStyle = (records) =>
        styled.every((r) =>
          records.some((s) => s.r.fontName === accent && s.r.str === r.r.str && s.r.height === em)
        )
    if (
      !after ||
      afterRows.length < 2 ||
      after.records.some(
        (r) => r.r.height !== em || !horizontal(r.r) || !fonts.includes(r.r.fontName)
      ) ||
      !fonts.every(
        (f) =>
          priorBody.records.some((r) => r.r.fontName === f) &&
          after.records.some((r) => r.r.fontName === f)
      ) ||
      styled.some((r) => !/^\p{L}{2,16}$/u.test(r.r.str)) ||
      !repeatedStyle(priorBody.records) ||
      !repeatedStyle(after.records)
    )
      return
    const trueCaption = parentCaptions[0],
      capRows = q.runs.filter((r) => inside(trueCaption.rect, rowRect(r))),
      cap = completeRows(q, capRows),
      captionFonts = cap && new Set(cap.records.map((r) => r.r.fontName))
    if (
      !cap ||
      !same(
        capRows.map((r) => r.text),
        trueCaption.lines
      ) ||
      !/[.!?]$/u.test(cap.records.at(-1).r.str) ||
      fonts.some((f) => captionFonts.has(f)) ||
      nextHeading.records.some((r) => !captionFonts.has(r.r.fontName))
    )
      return
    // A complete native section and its closed ordinary paragraph intervene
    // after the parent caption, so an unlabeled caption tail cannot borrow it.
    const parentColumn = q.runs.filter(
        (r) => r.x >= trueCaption.rect[0] - em / 4 && r.right <= trueCaption.rect[2] + em
      ),
      section = parentColumn.find((r) => r.y > trueCaption.rect[3] && heading.test(r.text)),
      sectionHeading = section && completeRows(q, [section]),
      followingSection =
        section && parentColumn.find((r) => r.y > section.bottom && heading.test(r.text)),
      sectionRows =
        section &&
        parentColumn.filter(
          (r) =>
            r.y > section.bottom &&
            (!followingSection || r.y < followingSection.y) &&
            Math.abs(r.fontSize - em) <= em * 0.015
        ),
      sectionBody = sectionRows && completeRows(q, sectionRows)
    if (
      !sectionHeading ||
      section.fontSize <= em ||
      sectionHeading.records.some((r) => !captionFonts.has(r.r.fontName)) ||
      !sectionBody ||
      sectionBody.records.some((r) => !horizontal(r.r)) ||
      sectionRows.length < 2 ||
      !/[.!?]$/u.test(sectionRows.at(-1).text)
    )
      return
    if (
      Math.min(...body.glyphs.map((g) => g.ink[1])) <=
      Math.max(...priorBody.glyphs.map((g) => g.ink[3]))
    )
      return
    const ownedGlyphs = new Set(body.glyphs),
      eligible = new Set(recordsFor(p, [priorRows.at(-1)]).flatMap((r) => r.part.map((z) => z.g))),
      firstLine = new Set(recordsFor(p, [bodyRows[0]]).flatMap((r) => r.part.map((z) => z.g))),
      foreignGlyphs = p.glyphs.filter((g) => positive(g) && !ownedGlyphs.has(g)),
      bodyAdvances = [
        ...body.glyphs.map((g) => ({ rect: g.advance, glyphs: [g] })),
        ...body.records.map((r) => ({ rect: r.rect, glyphs: [...new Set(r.part.map((z) => z.g))] }))
      ]
    let overhangs = 0
    for (const f of foreignGlyphs) {
      if (
        body.glyphs.some(
          (g) => hit(f.ink, g.ink) || hit(f.advance, g.ink) || hit(f.advance, g.advance)
        ) ||
        body.records.some((r) => hit(f.advance, r.rect))
      )
        return
      for (const a of bodyAdvances)
        if (hit(f.ink, a.rect)) {
          if (!eligible.has(f) || !a.glyphs.every((g) => firstLine.has(g) && f.ink[3] < g.ink[1]))
            return
          overhangs++
        }
    }
    for (const r of p.records.filter((r) => !body.records.includes(r))) {
      if (
        body.glyphs.some((g) => hit(r.rect, g.ink) || hit(r.rect, g.advance)) ||
        body.records.some((s) => hit(r.rect, s.rect))
      )
        return
    }
    if (!overhangs) return
    const envelope = [
      Math.min(...bodyAdvances.map((a) => a.rect[0]), ...body.glyphs.map((g) => g.ink[0])),
      Math.min(...bodyAdvances.map((a) => a.rect[1]), ...body.glyphs.map((g) => g.ink[1])),
      Math.max(...bodyAdvances.map((a) => a.rect[2]), ...body.glyphs.map((g) => g.ink[2])),
      Math.max(...bodyAdvances.map((a) => a.rect[3]), ...body.glyphs.map((g) => g.ink[3]))
    ]
    if (
      captions.some(
        (c) =>
          c !== candidate && c.page === page.pageNumber && (!valid(c.rect) || hit(envelope, c.rect))
      ) ||
      p.evidence.images.some((i) => !valid(i.rect) || hit(envelope, i.rect)) ||
      page.graphicsBounds.some(
        (g) =>
          !valid(g.normalizedRect) ||
          hit(
            envelope,
            g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
          )
      )
    )
      return
    for (const [i, state] of p.evidence.paths) {
      const a = p.o.argsArray[i]
      if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null))
        continue
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint || hit(envelope, paint.rect)) return
    }
    if (!sourceCurrent()) return
    return { current: sourceCurrent }
  } catch {
    return
  }
}

// A published duplicate may be omitted only after a complete ordinary opening
// paragraph and its distinct genuine caption/figure close. It grants no pixels
// or Source roles, and never mutates an earlier crop/association epoch.
export function nativeDuplicateOrdinaryReferenceMetadata(figure, page, captions, figures, native) {
  const continuation = nativeSamePageContinuationMetadata(figure, page, captions, figures, native)
  if (continuation) return continuation
  try {
    const finite = (r, n) => Array.isArray(r) && r.length === n && r.every(Number.isFinite),
      normalized = (r) =>
        finite(r, 4) && r.every((v) => v >= 0 && v <= 1) && r[0] < r[2] && r[1] < r[3],
      same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
      inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6)),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      union = (rs) => [
        Math.min(...rs.map((r) => r[0])),
        Math.min(...rs.map((r) => r[1])),
        Math.max(...rs.map((r) => r[2])),
        Math.max(...rs.map((r) => r[3]))
      ]
    if (
      !figure ||
      !normalized(figure.region) ||
      typeof figure.thumbnail !== 'string' ||
      figure.sourceItems?.length ||
      figure.page !== page?.pageNumber ||
      native?.pageNumber !== page.pageNumber ||
      page.rotation !== 0 ||
      page.renderRotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      !Array.isArray(captions) ||
      !Array.isArray(figures) ||
      !figures.includes(figure) ||
      !Array.isArray(page.graphicsBounds) ||
      !finite(native.viewport?.transform, 6) ||
      !same(native.viewport.transform, [1, 0, 0, -1, 0, page.height]) ||
      native.viewport.width !== page.width ||
      native.viewport.height !== page.height
    )
      return
    const matches = captions.filter(
      (c) =>
        c.page === figure.page &&
        same(c.lines, figure.caption?.lines) &&
        same(c.rect, figure.caption?.rect)
    )
    if (matches.length !== 1) return
    const candidate = matches[0],
      reference =
        /^(?:Figure|Fig\.)\s+([A-Z]?[1-9]\d*[a-z]?)\s+\p{Ll}{3,}s\s+(?:this|the|these|those|our|a|an)\s+\p{L}/u.exec(
          candidate.lines?.[0] ?? ''
        )
    if (
      !reference ||
      !finite(candidate.rect, 4) ||
      candidate.lines.length < 3 ||
      candidate.lines.length > 16 ||
      !/[.!?]$/u.test(candidate.lines.at(-1))
    )
      return
    const ordinal = reference[1],
      titles = captions.filter(
        (c) =>
          c !== candidate &&
          c.page === figure.page &&
          finite(c.rect, 4) &&
          new RegExp('^(?:Figure|Fig\\.)\\s+' + ordinal + '\\s*[:.]\\s+', 'u').test(
            c.lines?.[0] ?? ''
          )
      ),
      trueFigures = figures.filter(
        (f) =>
          f !== figure &&
          f.page === figure.page &&
          titles.some((c) => same(c.lines, f.caption?.lines) && same(c.rect, f.caption?.rect))
      )
    if (titles.length !== 1 || trueFigures.length !== 1) return
    const title = titles[0],
      genuine = trueFigures[0]
    if (
      !normalized(genuine.region) ||
      typeof genuine.thumbnail !== 'string' ||
      genuine.thumbnail === figure.thumbnail ||
      genuine.sourceItems?.length ||
      !inside(genuine.region, figure.region)
    )
      return
    const current = retainNativeRecoveryInputs(
      [figure, page, captions, figures, native],
      native.viewport
    )
    if (!current) return
    const tokens = native.content.items
        .filter((r) => r.str?.trim())
        .map((r) => tableTextToken(r, native.viewport, 0)),
      packet =
        nativePageTextPacketInventory(
          page,
          tokens,
          native,
          true,
          new Set(tokens.map((token) => token.sourceItem.index))
        ) ??
        nativePageTextPacketInventoryWithLigatureCertificate(
          page,
          tokens,
          native,
          native.dualApiEvidence,
          true
        )
    if (
      !packet ||
      packet.records.length > 4096 ||
      packet.evidence.paths.size > 4096 ||
      packet.records.some((r) => !r.advanceComplete)
    )
      return
    const physicalOwners = new Set()
    for (const record of packet.records)
      for (const glyph of new Set(record.part.map((part) => part.g))) {
        if (physicalOwners.has(glyph)) return
        physicalOwners.add(glyph)
      }
    const body = packet.records.filter((r) => inside(candidate.rect, r.rect)),
      cap = packet.records.filter((r) => inside(title.rect, r.rect)),
      first = body[0],
      last = body.at(-1),
      em = first?.r.height,
      font = first?.r.fontName,
      style = native.content.styles[font]
    if (
      !first ||
      body.length !== candidate.lines.length ||
      cap.length !== title.lines.length ||
      body.map((r) => r.r.str).join(' ') !== candidate.lines.join(' ') ||
      cap.map((r) => r.r.str).join(' ') !== title.lines.join(' ') ||
      !(em > 0) ||
      !Number.isFinite(style?.ascent) ||
      !Number.isFinite(style.descent) ||
      style.vertical !== false ||
      !/[.!?]$/u.test(last.r.str) ||
      !union(body.map((r) => r.rect)).every((v, i) => Math.abs(v - candidate.rect[i]) <= 1e-6)
    )
      return
    if (
      body.some(
        (r, i) =>
          !r.advanceComplete ||
          r.r.fontName !== font ||
          r.r.height !== em ||
          !finite(r.r.transform, 6) ||
          r.r.transform[1] !== 0 ||
          r.r.transform[2] !== 0 ||
          r.r.transform[0] !== em ||
          r.r.transform[3] !== em ||
          Math.abs(r.rect[0] - first.rect[0]) > 1e-6 ||
          (i > 0 &&
            (r.index <= body[i - 1].index ||
              r.rect[1] <= body[i - 1].rect[3] ||
              r.rect[1] - body[i - 1].rect[1] > em * 1.5))
      )
    )
      return
    const completePackets = (records) => {
      const glyphs = new Set(records.flatMap((r) => r.part.map((p) => p.g))),
        packets = new Set([...glyphs].map((g) => g.packet))
      return [...packets].every(
        (p) =>
          Number.isSafeInteger(p.start) &&
          Number.isSafeInteger(p.end) &&
          p.end > p.start &&
          p.glyphs.every((g) => glyphs.has(g) || !g.text.trim())
      )
    }
    if (!completePackets(body) || !completePackets(cap)) return
    const bodyRect = union(body.map((r) => r.rect)),
      badRect = figure.region.map((v, i) => v * (i % 2 ? page.height : page.width)),
      goodRect = genuine.region.map((v, i) => v * (i % 2 ? page.height : page.width)),
      bodyGlyphs = new Set(body.flatMap((r) => r.part.map((p) => p.g)))
    if (
      !(bodyRect[3] < goodRect[1] && bodyRect[3] < badRect[1] && goodRect[3] <= title.rect[1]) ||
      packet.glyphs.some((g) => !bodyGlyphs.has(g) && g.text.trim() && hit(g.ink, bodyRect)) ||
      page.graphicsBounds.some(
        (g) =>
          !finite(g.normalizedRect, 4) ||
          hit(
            g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
            bodyRect
          )
      )
    )
      return
    const before = packet.records.filter((r) => r.rect[3] <= first.rect[1]),
      after = packet.records.filter((r) => r.rect[1] >= title.rect[3]),
      heading = after.filter((r) => r.r.height > em && /[A-Z]/u.test(r.r.str)),
      ordinary = after.filter((r) => r.r.fontName === font && r.r.height === em)
    if (
      !before.length ||
      first.rect[1] - Math.max(...before.map((r) => r.rect[3])) < em ||
      !heading.length ||
      !ordinary.length ||
      heading.some((r) => {
        const s = native.content.styles[r.r.fontName]
        return !Number.isFinite(s?.ascent) || !Number.isFinite(s.descent) || s.vertical !== false
      }) ||
      !current()
    )
      return
    return { caption: candidate, current }
  } catch {
    return
  }
}

// A lower-case reference inside a native paragraph is optional metadata only.
// Whole Source records, including inline mathematics, retain their original roles.
function nativeSamePageContinuationMetadata(figure, page, captions, figures, native) {
  try {
    const finite = (r, n) => Array.isArray(r) && r.length === n && r.every(Number.isFinite),
      same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
      near = (a, b) => Math.abs(a - b) <= 1e-6,
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3],
      normalized = (r) => valid(r) && r.every((n) => n >= 0 && n <= 1),
      union = (rs) => [
        Math.min(...rs.map((r) => r[0])),
        Math.min(...rs.map((r) => r[1])),
        Math.max(...rs.map((r) => r[2])),
        Math.max(...rs.map((r) => r[3]))
      ]
    if (
      !normalized(figure?.region) ||
      typeof figure.thumbnail !== 'string' ||
      figure.sourceItems !== undefined ||
      figure.parts !== undefined ||
      figure.page !== page?.pageNumber ||
      native?.pageNumber !== page.pageNumber ||
      page.rotation !== 0 ||
      page.renderRotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      !Array.isArray(page.lines) ||
      !Array.isArray(page.graphicsBounds) ||
      !Array.isArray(captions) ||
      !Array.isArray(figures) ||
      !figures.includes(figure) ||
      !same(native.viewport?.transform, [1, 0, 0, -1, 0, page.height]) ||
      native.viewport.width !== page.width ||
      native.viewport.height !== page.height
    )
      return
    const matches = captions.filter(
      (c) =>
        c.page === figure.page &&
        same(c.lines, figure.caption?.lines) &&
        same(c.rect, figure.caption?.rect)
    )
    if (matches.length !== 1) return
    const candidate = matches[0],
      reference = /^figure\s+([A-Z]?[1-9]\d*[a-z]?)\.\s+\p{Lu}/u.exec(candidate.lines?.[0] ?? '')
    if (
      !reference ||
      !valid(candidate.rect) ||
      candidate.lines.length < 3 ||
      candidate.lines.length > 16 ||
      !/[.!?]$/u.test(candidate.lines.at(-1))
    )
      return
    const titles = captions.filter(
        (c) =>
          c !== candidate &&
          c.page === figure.page &&
          valid(c.rect) &&
          new RegExp('^(?:Figure|Fig\\.)\\s+' + reference[1] + '\\s*[:.]\\s+', 'u').test(
            c.lines?.[0] ?? ''
          )
      ),
      genuine = figures.filter(
        (f) =>
          f !== figure &&
          f.page === figure.page &&
          titles.some((c) => same(c.lines, f.caption?.lines) && same(c.rect, f.caption?.rect))
      )
    if (
      titles.length !== 1 ||
      genuine.length !== 1 ||
      !normalized(genuine[0].region) ||
      typeof genuine[0].thumbnail !== 'string' ||
      genuine[0].thumbnail === figure.thumbnail ||
      genuine[0].sourceItems !== undefined
    )
      return
    const current = retainNativeRecoveryInputs(
      [figure, page, captions, figures, native],
      native.viewport
    )
    if (!current) return
    const tokens = native.content.items
        .filter((r) => r.str?.trim())
        .map((r) => tableTextToken(r, native.viewport, 0)),
      packet = nativePageTextPacketInventory(
        page,
        tokens,
        native,
        true,
        new Set(tokens.map((t) => t.sourceItem.index))
      )
    if (
      !packet ||
      packet.records.length > 4096 ||
      packet.evidence.paths.size > 4096 ||
      packet.records.some((r) => !r.advanceComplete)
    )
      return
    const origins = new WeakMap(),
      runs = groupPageLines(page, [], origins),
      recordFor = (line) => {
        const box = [line.x, line.y, line.x + line.width, line.y + line.height],
          records = packet.records.filter((r) =>
            r.rect.every((v, i) => (i < 2 ? v >= box[i] - 1e-6 : v <= box[i] + 1e-6))
          )
        if (!records.length || !union(records.map((r) => r.rect)).every((v, i) => near(v, box[i])))
          return []
        const source = native.content.items.slice(records[0].index, records.at(-1).index + 1)
        return source.filter((r) => r.str?.trim()).length === records.length &&
          joinPdfSmallCapsLine(source) === line.text
          ? records
          : []
      },
      rows = candidate.lines.map((text) =>
        runs.filter(
          (r) =>
            r.text === text &&
            r.x >= candidate.rect[0] - 1e-6 &&
            r.right <= candidate.rect[2] + 1e-6 &&
            r.y >= candidate.rect[1] - 1e-6 &&
            r.bottom <= candidate.rect[3] + 1e-6
        )
      )
    if (rows.some((r) => r.length !== 1)) return
    const bodyRows = rows.map((r) => r[0]),
      body = bodyRows.map((r) => (origins.get(r) ?? []).map(recordFor)),
      capRows = titles[0].lines.map((text) =>
        runs.filter(
          (r) =>
            r.text === text &&
            r.x >= titles[0].rect[0] - 1e-6 &&
            r.right <= titles[0].rect[2] + 1e-6 &&
            r.y >= titles[0].rect[1] - 1e-6 &&
            r.bottom <= titles[0].rect[3] + 1e-6
        )
      )
    if (
      body.some((row) => !row.length || row.some((r) => !r.length)) ||
      capRows.some((r) => r.length !== 1)
    )
      return
    const bodyRecords = body.map((row) => row.flat()),
      selected = bodyRecords.flat(),
      first = selected[0],
      last = selected.at(-1),
      prior = packet.records.filter((r) => r.index < first.index).at(-1),
      em = first.r.height,
      font = first.r.fontName,
      validRecord = (r) => {
        const s = native.content.styles[r.r.fontName],
          t = r.r.transform
        return (
          valid(r.rect) &&
          r.rect[0] >= 0 &&
          r.rect[1] >= 0 &&
          r.rect[2] <= page.width &&
          r.rect[3] <= page.height &&
          Number.isFinite(s?.ascent) &&
          Number.isFinite(s.descent) &&
          s.vertical === false &&
          r.r.height > 0 &&
          finite(t, 6) &&
          t[0] === r.r.height &&
          t[1] === 0 &&
          t[2] === 0 &&
          t[3] === r.r.height
        )
      },
      bodyBox = union(bodyRows.map((r) => [r.x, r.y, r.right, r.bottom]))
    if (
      !(em > 0) ||
      !prior ||
      !validRecord(prior) ||
      prior.r.fontName !== font ||
      prior.r.height !== em ||
      !prior.r.hasEOL ||
      /[.!?:;]$/u.test(prior.r.str) ||
      !/\p{Ll}$/u.test(prior.r.str) ||
      (prior.r.str.match(/\p{L}{2,}/gu) ?? []).length < 6 ||
      !near(prior.rect[0], first.rect[0]) ||
      prior.rect[3] >= first.rect[1] ||
      first.rect[1] - prior.rect[1] < em ||
      first.rect[1] - prior.rect[1] > em * 1.5 ||
      selected.some((r) => !validRecord(r)) ||
      !bodyBox.every((v, i) => near(v, candidate.rect[i]))
    )
      return
    for (const [i, row] of bodyRecords.entries()) {
      const baseline = row.filter((r) => r.r.fontName === font && r.r.height === em)
      if (
        !baseline.length ||
        !near(bodyRows[i].x, prior.rect[0]) ||
        !near(bodyRows[i].fontSize, em) ||
        (i &&
          (bodyRows[i].bottom - bodyRows[i - 1].bottom < em ||
            bodyRows[i].bottom - bodyRows[i - 1].bottom > em * 1.5)) ||
        row.some((r, j) => j && r.index <= row[j - 1].index)
      )
        return
      if (
        i < bodyRecords.length - 1 &&
        !native.content.items
          .slice(row.at(-1).index, bodyRecords[i + 1][0].index)
          .some((r) => r.hasEOL === true)
      )
        return
    }
    const domain = [prior, ...selected],
      indices = new Set(domain.map((r) => r.index)),
      glyphs = new Set(),
      capMatches = capRows.flatMap((row) => origins.get(row[0]) ?? []).map(recordFor),
      capRecords = capMatches.flat()
    if (
      indices.size !== domain.length ||
      capMatches.some((r) => !r.length) ||
      native.content.items.some(
        (r, i) => i >= prior.index && i <= last.index && r.str?.trim() && !indices.has(i)
      )
    )
      return
    for (const r of [...domain, ...capRecords]) {
      if (!validRecord(r)) return
      for (const g of new Set(r.part.map((part) => part.g))) {
        if (glyphs.has(g)) return
        glyphs.add(g)
      }
    }
    const finalGlyphs = last.part.map((p) => p.g)
    if (
      !last.r.hasEOL &&
      !finalGlyphs.every(
        (g) =>
          Number.isSafeInteger(g.packet?.end) &&
          native.operators.fnArray[g.packet.end] === OPS.endText &&
          g.packet.glyphs.every(
            (other) =>
              !other.text.trim() || other.i <= Math.max(...finalGlyphs.map((last) => last.i))
          )
      )
    )
      return
    const bodyGlyphs = new Set(domain.flatMap((r) => r.part.map((p) => p.g))),
      envelope = union([
        ...domain.map((r) => r.rect),
        ...[...bodyGlyphs].flatMap((g) => [g.ink, g.advance])
      ]),
      bad = figure.region.map((v, i) => v * (i % 2 ? page.height : page.width)),
      good = genuine[0].region.map((v, i) => v * (i % 2 ? page.height : page.width))
    if (
      !(envelope[3] < bad[1] && envelope[3] < good[1] && good[3] <= titles[0].rect[1]) ||
      captions.some(
        (c) =>
          c !== candidate && c.page === figure.page && (!valid(c.rect) || hit(c.rect, envelope))
      ) ||
      packet.glyphs.some(
        (g) =>
          !bodyGlyphs.has(g) && g.text.trim() && (hit(g.ink, envelope) || hit(g.advance, envelope))
      ) ||
      page.graphicsBounds.some(
        (g) =>
          !valid(g.normalizedRect) ||
          hit(
            g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
            envelope
          )
      )
    )
      return
    for (const [i, state] of packet.evidence.paths) {
      const a = packet.o.argsArray[i]
      if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null))
        continue
      const paint = nativeFigurePathPaint(packet, i, state)
      if (!paint || hit(paint.rect, envelope)) return
    }
    if (!current()) return
    return { caption: candidate, current, withdrawThumbnail: figure.thumbnail }
  } catch {
    return
  }
}

// This sentence bridge can withdraw optional metadata only. It grants neither
// the continued paragraph nor a shared BT any Source, paint or crop authority.
export function nativeCrossPageSentenceReferenceMetadata(
  figure,
  page,
  captions,
  figures,
  native,
  previousFrame,
  currentFrame
) {
  try {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b),
      finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
      valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3],
      near = (a, b) => Math.abs(a - b) <= 1e-6,
      inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6)),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      normalized = (r) => valid(r) && r.every((v) => v >= 0 && v <= 1),
      rowRect = (r) => [r.x, r.y, r.right, r.bottom],
      prior = nativeRecoveryOwnValues(previousFrame),
      actual = nativeRecoveryOwnValues(currentFrame),
      priorPage = prior?.pageGeometry,
      priorNative = prior?.context
    if (
      !nativeRecoveryOwnValues(figure) ||
      !nativeRecoveryOwnValues(native) ||
      !nativeRecoveryOwnValues(priorNative) ||
      actual?.context !== native ||
      actual.pageGeometry !== page ||
      !actual.nativePage ||
      !prior.nativePage ||
      actual.nativePage.commonObjs !== prior.nativePage.commonObjs ||
      !normalized(figure.region) ||
      typeof figure.thumbnail !== 'string' ||
      figure.sourceItems !== undefined ||
      figure.parts !== undefined ||
      figure.page !== page?.pageNumber ||
      native.pageNumber !== page.pageNumber ||
      priorPage?.pageNumber !== page.pageNumber - 1 ||
      priorNative.pageNumber !== priorPage.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(native.sourceSha256 ?? '') ||
      native.sourceSha256 !== priorNative.sourceSha256 ||
      page.width !== priorPage.width ||
      page.height !== priorPage.height ||
      ![captions, figures].every(Array.isArray) ||
      !figures.includes(figure)
    )
      return
    const retained = retainNativeRecoveryInputs(
      [
        figure,
        page,
        captions,
        figures,
        native,
        priorPage,
        priorNative,
        actual.nativeContent,
        prior.nativeContent
      ],
      native.viewport,
      priorNative.viewport
    )
    if (!retained) return
    const current = () => {
      const p = nativeRecoveryOwnValues(previousFrame),
        a = nativeRecoveryOwnValues(currentFrame)
      return (
        p?.pageGeometry === priorPage &&
        p.context === priorNative &&
        p.nativePage === prior.nativePage &&
        p.nativeContent === prior.nativeContent &&
        a?.pageGeometry === page &&
        a.context === native &&
        a.nativePage === actual.nativePage &&
        a.nativeContent === actual.nativeContent &&
        retained()
      )
    }
    const matches = captions.filter(
      (c) =>
        c.page === figure.page &&
        same(c.lines, figure.caption?.lines) &&
        same(c.rect, figure.caption?.rect)
    )
    if (matches.length !== 1) return
    const candidate = matches[0],
      reference = /^figure\s+([A-Z]?[1-9]\d*[a-z]?)\.\s+\p{Lu}/u.exec(candidate.lines?.[0] ?? '')
    if (
      !reference ||
      !valid(candidate.rect) ||
      candidate.lines.length < 3 ||
      !/[.!?]$/u.test(candidate.lines.at(-1))
    )
      return
    const frame = (geometry, context) => {
        if (
          geometry.rotation !== 0 ||
          geometry.renderRotation !== 0 ||
          geometry.invalidGraphicsBounds !== 0 ||
          !Array.isArray(geometry.lines) ||
          geometry.lines.length > 4096 ||
          !same(context.viewport?.transform, [1, 0, 0, -1, 0, geometry.height])
        )
          return
        const tokens = context.content.items
            .filter((r) => r.str?.trim())
            .map((r) => tableTextToken(r, context.viewport, 0)),
          packet = nativePageTextPacketInventory(geometry, tokens, context, true)
        if (!packet || packet.records.length > 4096 || packet.evidence.paths.size > 4096) return
        const owner = new Map()
        for (const r of packet.records) {
          const style = context.content.styles[r.r.fontName]
          if (
            !Number.isFinite(style?.ascent) ||
            style.ascent <= 0 ||
            !Number.isFinite(style.descent) ||
            style.descent > 0 ||
            style.vertical !== false
          )
            return
          for (const g of new Set(r.part.map((p) => p.g))) {
            if (owner.has(g)) return
            owner.set(g, r)
          }
        }
        if (packet.glyphs.some((g) => g.text.trim() && !owner.has(g))) return
        return { ...packet, owner, runs: groupPageLines(geometry) }
      },
      p = frame(page, native),
      q = frame(priorPage, priorNative)
    if (!p || !q) return
    const validRecord = (r, geometry) => {
        const t = r.r.transform
        return (
          valid(r.rect) &&
          inside([0, 0, geometry.width, geometry.height], r.rect) &&
          finite(t, 6) &&
          r.r.dir === 'ltr' &&
          r.r.height > 0 &&
          t[0] === r.r.height &&
          t[1] === 0 &&
          t[2] === 0 &&
          t[3] === r.r.height
        )
      },
      completeSingleLine = (packet, row, geometry) => {
        const records = packet.records.filter(
          (r) => r.r.str === row.text && r.rect.every((v, i) => near(v, rowRect(row)[i]))
        )
        if (records.length !== 1) return
        const r = records[0]
        return validRecord(r, geometry) &&
          r.r.str === row.text &&
          r.rect.every((v, i) => near(v, rowRect(row)[i]))
          ? r
          : undefined
      },
      firstRows = p.runs.filter(
        (r) =>
          r.text === candidate.lines[0] &&
          rowRect(r).every((v, i) =>
            i === 3
              ? v <= candidate.rect[3]
              : i < 2
                ? v >= candidate.rect[i] - 1e-6
                : v <= candidate.rect[i] + 1e-6
          )
      ),
      first = firstRows.length === 1 && completeSingleLine(p, firstRows[0], page)
    if (!first || !near(first.rect[1], candidate.rect[1])) return
    const em = first.r.height,
      font = first.r.fontName,
      endings = q.runs.filter(
        (r) => /\p{Ll}\s+in$/u.test(r.text) && (r.text.match(/\p{L}{2,}/gu) ?? []).length >= 6
      ),
      terminal = endings.map((r) => completeSingleLine(q, r, priorPage)).filter(Boolean)
    if (terminal.length !== 1) return
    const last = terminal[0],
      previousRows = q.runs
        .filter(
          (r) => r.bottom <= last.rect[1] && near(r.x, last.rect[0]) && near(r.right, last.rect[2])
        )
        .sort((a, b) => a.y - b.y),
      priorLine = previousRows.at(-1),
      priorRecord = priorLine && completeSingleLine(q, priorLine, priorPage)
    const bindFont = (f, context, sourceFont) => {
        const content = f.nativeContent,
          nativePage = f.nativePage,
          common = nativePage.commonObjs,
          get = common?.get,
          aliases = new Map(),
          reverse = new Map()
        if (
          !Array.isArray(content?.items) ||
          content.items.length !== context.content.items.length ||
          typeof get !== 'function'
        )
          return
        for (let i = 0; i < content.items.length; i++) {
          const a = content.items[i],
            b = context.content.items[i]
          if (
            ['str', 'dir', 'width', 'height', 'transform', 'hasEOL'].some(
              (k) => !same(a[k], b[k])
            ) ||
            !same(content.styles[a.fontName], context.content.styles[b.fontName]) ||
            (aliases.has(b.fontName) && aliases.get(b.fontName) !== a.fontName) ||
            (reverse.has(a.fontName) && reverse.get(a.fontName) !== b.fontName)
          )
            return
          aliases.set(b.fontName, a.fontName)
          reverse.set(a.fontName, b.fontName)
        }
        const name = aliases.get(sourceFont),
          face = get.call(common, name),
          glyphs = context.glyphBounds.filter((g) => g.fontName === sourceFont)
        if (
          !face ||
          face.loadedName !== name ||
          face.missingFile !== false ||
          face.isType3Font !== false ||
          face.isInvalidPDFjsFont !== false ||
          face.vertical !== false ||
          face.disableFontFace !== true ||
          !finite(face.fontMatrix, 6) ||
          !Number.isFinite(face.ascent) ||
          face.ascent <= 0 ||
          !Number.isFinite(face.descent) ||
          face.descent > 0 ||
          glyphs.length !== 1 ||
          !glyphs[0].glyphs.length ||
          typeof face.getPathGenerator !== 'function' ||
          glyphs[0].glyphs.some(
            (g) =>
              !same(Array.from(face.getPathGenerator(common, g.fontChar).getBounds()), g.bounds)
          )
        )
          return
        const descriptors = Object.getOwnPropertyDescriptors(face),
          keys = Reflect.ownKeys(descriptors),
          prototype = Object.getPrototypeOf(face),
          prototypeDescriptors = Object.getOwnPropertyDescriptors(prototype),
          prototypeKeys = Reflect.ownKeys(prototypeDescriptors),
          prototypeParent = Object.getPrototypeOf(prototype),
          matrix = face.fontMatrix,
          matrixValues = [...matrix],
          path = face.getPathGenerator,
          flags = [
            face.loadedName,
            face.missingFile,
            face.isType3Font,
            face.isInvalidPDFjsFont,
            face.vertical,
            face.disableFontFace,
            face.ascent,
            face.descent
          ]
        return {
          face,
          current: () => {
            try {
              return (
                f.nativePage === nativePage &&
                f.nativeContent === content &&
                nativePage.commonObjs === common &&
                common.get === get &&
                get.call(common, name) === face &&
                Object.getPrototypeOf(face) === prototype &&
                Object.getPrototypeOf(prototype) === prototypeParent &&
                Reflect.ownKeys(prototype).length === prototypeKeys.length &&
                prototypeKeys.every(
                  (k, i) =>
                    Reflect.ownKeys(prototype)[i] === k &&
                    ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(
                      (field) =>
                        Object.getOwnPropertyDescriptor(prototype, k)?.[field] ===
                        prototypeDescriptors[k][field]
                    )
                ) &&
                Reflect.ownKeys(face).length === keys.length &&
                Reflect.ownKeys(face).every((k, i) => k === keys[i]) &&
                keys.every((k) => {
                  const d = Object.getOwnPropertyDescriptor(face, k),
                    old = descriptors[k]
                  return (
                    d &&
                    d.value === old.value &&
                    d.get === old.get &&
                    d.set === old.set &&
                    d.writable === old.writable &&
                    d.enumerable === old.enumerable &&
                    d.configurable === old.configurable
                  )
                }) &&
                same(face.fontMatrix, matrixValues) &&
                same(matrix, matrixValues) &&
                face.getPathGenerator === path &&
                glyphs[0].glyphs.every((g) =>
                  same(Array.from(face.getPathGenerator(common, g.fontChar).getBounds()), g.bounds)
                ) &&
                same(
                  [
                    face.loadedName,
                    face.missingFile,
                    face.isType3Font,
                    face.isInvalidPDFjsFont,
                    face.vertical,
                    face.disableFontFace,
                    face.ascent,
                    face.descent
                  ],
                  flags
                )
              )
            } catch {
              return false
            }
          }
        }
      },
      bodyFont = bindFont(currentFrame, native, font),
      priorFont = bindFont(previousFrame, priorNative, last.r.fontName)
    if (
      !priorRecord ||
      !validRecord(first, page) ||
      !bodyFont ||
      !priorFont ||
      bodyFont.face !== priorFont.face ||
      [last, priorRecord].some((r) => r.r.fontName !== last.r.fontName || r.r.height !== em) ||
      !same(native.content.styles[font], priorNative.content.styles[last.r.fontName]) ||
      !near(last.rect[2] - last.rect[0], first.rect[2] - first.rect[0]) ||
      last.rect[1] < priorPage.height * 0.65 ||
      last.rect[1] - priorRecord.rect[1] < em ||
      last.rect[1] - priorRecord.rect[1] > em * 1.5 ||
      q.records.some(
        (r) =>
          r !== last &&
          r.rect[3] > last.rect[1] &&
          !(
            r.rect[1] > priorPage.height * 0.9 &&
            r.r.height < em &&
            validRecord(r, priorPage) &&
            r.rect[0] >= last.rect[0] &&
            r.rect[2] <= last.rect[2]
          )
      )
    )
      return
    const titles = captions.filter(
        (c) =>
          c !== candidate &&
          c.page === figure.page &&
          valid(c.rect) &&
          /^(?:Figure|Fig\.)\s+([A-Z]?[1-9]\d*[a-z]?)\s*[:.]\s+/u.test(c.lines?.[0] ?? '') &&
          !new RegExp('^(?:Figure|Fig\\.)\\s+' + reference[1] + '\\s*[:.]', 'u').test(c.lines[0]) &&
          c.rect[3] < first.rect[1]
      ),
      genuine = figures.filter(
        (f) =>
          f !== figure &&
          f.page === figure.page &&
          normalized(f.region) &&
          typeof f.thumbnail === 'string' &&
          f.thumbnail !== figure.thumbnail &&
          f.sourceItems === undefined &&
          f.parts === undefined &&
          inside(figure.region, f.region) &&
          titles.some((c) => same(c.lines, f.caption?.lines) && same(c.rect, f.caption?.rect))
      )
    if (genuine.length !== 1) return
    const title = titles.filter(
      (c) => same(c.lines, genuine[0].caption.lines) && same(c.rect, genuine[0].caption.rect)
    )
    if (
      title.length !== 1 ||
      captions.some(
        (c) =>
          c !== candidate &&
          c !== title[0] &&
          c.page === page.pageNumber &&
          hit(c.rect, candidate.rect)
      )
    )
      return
    const titleRecords = p.records.filter((r) => inside(title[0].rect, r.rect)),
      titleGlyphs = new Set(titleRecords.flatMap((r) => r.part.map((z) => z.g))),
      corridor = [first.rect[0], title[0].rect[3], first.rect[2], first.rect[1]],
      firstGlyphs = new Set(first.part.map((z) => z.g)),
      lastGlyphs = new Set(last.part.map((z) => z.g))
    if (
      !titleRecords.length ||
      !valid(corridor) ||
      p.records.some((r) => r !== first && !titleRecords.includes(r) && hit(r.rect, corridor)) ||
      p.glyphs.some(
        (g) =>
          !titleGlyphs.has(g) &&
          !firstGlyphs.has(g) &&
          (hit(g.ink, corridor) || hit(g.advance, corridor))
      ) ||
      q.records
        .filter((r) => r.rect[1] > last.rect[3])
        .some((r) =>
          r.part.some(({ g }) =>
            [...lastGlyphs].some((own) =>
              [g.ink, g.advance].some((a) => [own.ink, own.advance].some((b) => hit(a, b)))
            )
          )
        )
    )
      return
    const graphicOwners = (f) => page.graphicsBounds.filter((g) => hit(g.normalizedRect, f.region)),
      genuineGraphics = graphicOwners(genuine[0]),
      ghostGraphics = graphicOwners(figure),
      good = genuine[0].region.map((v, i) => v * (i % 2 ? page.height : page.width))
    if (
      !genuineGraphics.length ||
      genuineGraphics.length !== ghostGraphics.length ||
      genuineGraphics.some((g, i) => g !== ghostGraphics[i]) ||
      good[3] > title[0].rect[1]
    )
      return
    // Only these two complete native lines are the sentence proof. Other body
    // lines, their descenders and all shared-BT glyphs keep their old authority.
    for (const [packet, record] of [
      [q, last],
      [p, first]
    ]) {
      const glyphs = new Set(record.part.map((z) => z.g))
      if (
        packet.glyphs.some((g) => !glyphs.has(g) && [...glyphs].some((own) => hit(g.ink, own.ink)))
      )
        return
      for (const [i, state] of packet.evidence.paths) {
        const a = packet.o.argsArray[i]
        if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null))
          continue
        const paint = nativeFigurePathPaint(packet, i, state)
        if (!paint || hit(paint.rect, record.rect) || (packet === p && hit(paint.rect, corridor)))
          return
      }
    }
    const publicationCurrent = () => current() && bodyFont.current() && priorFont.current()
    if (!publicationCurrent()) return
    return { caption: candidate, current: publicationCurrent, withdrawThumbnail: figure.thumbnail }
  } catch {
    return
  }
}

// Original stream-order producer projection, shared without granting text authority.
export function projectPdfTextLines(content, viewport, origins) {
  const lines = []
  let pending = []
  const flush = () => {
    if (!pending.length) return
    const text = joinPdfSmallCapsLine(pending)
    if (text) {
      // PDF.js synthetic spacing items can have zero height and oversized widths.
      // Preserve their text above, but do not treat invisible whitespace as painted bounds.
      const rects = pending
        .filter((item) => item.str.trim())
        .map((item) => {
          const [a, b, c, d, x, y] = item.transform
          const horizontal = Math.hypot(a, b)
          const vertical = Math.hypot(c, d)
          assert(horizontal > 0 && vertical > 0, 'Degenerate text transform.')
          // Retain each item's orientation, including chart-axis labels. These are advance
          // boxes, not exact glyph ink bounds; line grouping below remains stream-order based.
          const points = [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1]
          ].map(([u, v]) =>
            viewport.convertToViewportPoint(
              x + (u * item.width * a) / horizontal + (v * item.height * c) / vertical,
              y + (u * item.width * b) / horizontal + (v * item.height * d) / vertical
            )
          )
          return {
            x: Math.min(...points.map((point) => point[0])),
            y: Math.min(...points.map((point) => point[1])),
            right: Math.max(...points.map((point) => point[0])),
            bottom: Math.max(...points.map((point) => point[1]))
          }
        })
      const x = Math.min(...rects.map((rect) => rect.x))
      const y = Math.min(...rects.map((rect) => rect.y))
      lines.push({
        text,
        fontSize: Math.max(...pending.map((item) => item.height)),
        x,
        y,
        width: Math.max(...rects.map((rect) => rect.right)) - x,
        height: Math.max(...rects.map((rect) => rect.bottom)) - y
      })
      origins?.set(lines.at(-1), [...pending])
    }
    pending = []
  }
  for (const item of content.items) {
    if (!('str' in item)) continue
    if (startsDetachedTableCaption(pending, item) || startsDetachedTextColumn(pending, item))
      flush()
    if (
      pending.length &&
      Math.abs(
        viewport.convertToViewportPoint(...pending.at(-1).transform.slice(4))[1] -
          viewport.convertToViewportPoint(...item.transform.slice(4))[1]
      ) > 2
    )
      flush()
    pending.push(item)
    if (item.hasEOL) flush()
  }
  flush()
  return lines
}
