import {
  nativeCaptionRaisedIndexLines,
  nativeCaptionLiteralFragments,
  nativeCaptionOwnedInlineFragments
} from './literature-pdf-native-caption-script-order.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Offline geometry heuristic; a caption candidate is not a semantic classification.
import assert from 'node:assert/strict'
import { recoverNativeRaisedCaptionFragments } from './literature-pdf-native-caption-raised-glyphs.mjs'

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

export function captionKind(text) {
  // A printed supplementary ordinal may use several letters. Classify only
  // its punctuation-delimited title through the existing single-letter
  // grammar; the source label and all prose-reference guards remain intact.
  text = (text ?? '').replace(
    /^((?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure)\s+)[A-Z]{2,3}(\d+(?:\.\d+)*)(?=[.:]\s+\p{L})/u,
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
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+[A-Za-z]\.[\s]+(?:The|This|These|Those|Our|Their|It|They|Results?)\b[^.!?]{0,90}\b(?:is|are|was|were|has|have|had|does|do|did|shows?|demonstrates?|indicates?|describes?|reveals?|suggests?|compares?|contains?|includes?|uses?|achieves?|improves?|changes?|remains?|represents?|provides?|illustrates?)\b/i.test(
      text
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+and\s+(?:Fig\.?|Figure)\s+[A-Z]?\d+\.[\s]+(?:As|For|In|When|Where|Since|Because|The|This|These|Those)\b/i.test(
      text
    ) ||
    /^(?:Fig\.?|Figure)\s+[A-Z]?\d+[A-Za-z]?\s+and\s+(?:suggests?|shows?|indicates?|demonstrates?|describes?|reveals?)\b/i.test(
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
  // Apply the shared prose guards before the appendix branch can return.
  // Panel markers and hyphenated labels cannot hide a finite narrative verb;
  // punctuation-delimited noun titles keep their ordinary caption ownership.
  const narrativeReferenceLabel =
    '(?:(?:Supplementary|Supplemental)\\s+)?(?:Table|Tab\\.?|Chart|Fig\\.?|Figure)\\s+(?:[A-Z]?\\d+(?:\\.\\d+)?|[A-Z][.-]\\d+(?:\\.\\d+)*|[IVXLCDM]+)'
  const narrativeReferencePanel =
    '(?:\\s*\\((?:[A-Za-z]|left|right|top|bottom|middle|center|centre)\\)(?:\\s*(?:,|and|&)\\s*\\((?:[A-Za-z]|left|right|top|bottom|middle|center|centre)\\))*)?'
  const narrativeReferenceVerb =
    '(?:is|are|was|were|has|have|had|shows?|shown|presents?|presented|compares?|compared(?=\\s+(?:the|these|those|this|that|our)\\b)|contrasts?|measures?|reports?|reported|confirms?|reveals?|illustrat(?:es?|ed)|visuali[sz](?:es?|ed)|analy[sz](?:es?|ed)|provides?|plots|gives?|follows?|splits?|separates?|breaks?|lists?|decomposes?|contains?|depict(?:s|ed)?|represents?|reiterates?|reviews?|summari[sz](?:e(?:s|d)?|ing)|indicates?|suggests?|describes?|demonstrates?|displays?|exhibits?|achieves?|carr(?:y|ies|ied)|extends?|preserves?|retains?|grounds?|defines?|makes?|sets?|adds?|complements?|uses?(?=\\s+(?:one|a|an|the|our|this|these|those|its|their|\\d+)\\b)|examines?|var(?:y|ies|ied)|evaluates?|isolates?|paves?|introduces?)'
  const narrativeReference = new RegExp(
    `^${narrativeReferenceLabel}${narrativeReferencePanel}(?:\\s*(?:,|and|&)\\s*${narrativeReferenceLabel}${narrativeReferencePanel})*\\s+(?:(?:also|further)\\s+)?${narrativeReferenceVerb}\\b`,
    'i'
  )
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
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure|Table)\s+[A-Z]?\d+(?:\s+[A-Z](?:\s*(?:[+,&/–-]|and)\s*[A-Z])*)?(?:\s+and\s+(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure|Table)\s+[A-Z]?\d+)?\)\./i.test(
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
  if (
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*[.:]\s+(?:As|For|In|When|Where|Since|Because|Like|Unlike)\b(?=[\s\S]*\b(?:is|are|was|were|has|have|had|does|do|did|shows?|presents?|contains?|includes?|uses?|provides?|reports?|describes?|demonstrates?|indicates?|suggests?|reveals?|means?)\b)/i.test(
      text ?? ''
    )
  )
    return undefined
  if (/^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+we\s+plot\b/i.test(text ?? '')) return undefined
  if (/^(?:Fig\.?|Figure)\s+[A-Z]?\d+\s+asks?\s+whether\b/i.test(text ?? '')) return undefined
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
  // adverbs ending in -ly so noun-phrase captions such as "Figure 4 visual
  // comparison ..." remain eligible.
  const adverbNarrativeReference = new RegExp(
    `^(?:(?:Supplementary|Supplemental)\\s+)?(?:Fig\\.?|Figure|Chart)\\s+(?:[A-Z]?\\d+(?:\\.\\d+)?|[A-Z]\\.\\d+|[IVXLCDM]+)${narrativeReferencePanel}\\s+[a-z]+ly\\s+${narrativeReferenceVerb}\\b`,
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
    /^(?:Table|Chart|Fig\.?|Figure)\s+[A-Z]?\d+(?:\s+and\s+(?:(?:Supplementary|Supplemental)\s+)?(?:Table|Chart|Fig\.?|Figure)\s+[A-Z]?\d+)?\s+(?:shows?|shown|presents?|presented|compares?|compared(?=\s+(?:the|these|those|this|that|our)\b)|illustrat(?:es?|ed)|visuali[sz](?:es?|ed)|plots|gives?|follows?|depict(?:s|ed)?|represents?|reiterates?|reviews?|summari[sz](?:e(?:s|d)?|ing)|indicates?|suggests?|describes?|demonstrates?)\b/i.test(
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

export function groupPageLines(page, rules = []) {
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
        runs.push(run)
        runColumn = partColumn
        runFramedFloatCaption = framedFloatCaptionLines.has(part)
      }
      previous = part
    }
  }
  return runs
}

// A PDF stream may omit EOL between prose and a numbered caption in the other
// column. Invisible spacing tokens must not bridge that physical gutter.
export function startsDetachedTableCaption(pending, item) {
  const previous = pending.findLast((i) => i.str.trim())
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
        captionKind(row.text) ||
        /^Notes?\s*[:.]/iu.test(row.text)
      )
        break
      leading ??= gap
      const terminal =
        rows.length >= 2 &&
        /[.!?]$/u.test(row.text.trim()) &&
        !/[.!?]$/u.test(previous.text.trim()) &&
        row.x - start.x > em * 0.2 &&
        row.right - row.x >= em * 3 &&
        row.right - row.x < (start.right - start.x) * 0.98 &&
        Math.abs(row.x + row.right - start.x - start.right) < em * 0.04
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
    previous = rows.at(-2)
  if (
    !/[.!?]$/u.test(last.text.trim()) ||
    /[.!?]$/u.test(previous.text.trim()) ||
    last.x - start.x <= em * 0.2 ||
    Math.abs(last.x + last.right - start.x - start.right) >= em * 0.04
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
              r[2] - r[0] >= (start.right - start.x) * 0.5 &&
              (r[2] - r[0]) * (r[3] - r[1]) >= page.width * page.height * 0.04
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
    if (
      owners.length !== 1 ||
      runs.some(
        (l) =>
          l !== start &&
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
    (styled && (Math.abs(indent) > em * 0.05 || firstGap < em * 0.95 || firstGap > em * 1.5))
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
  if (
    !/[.!?]$/u.test(last.text.trim()) ||
    rows.slice(1, -1).some((r) => r.right - r.x < (edge - left) * 0.85)
  )
    return
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
// Its complete paragraph needs an aligned full-width run, a short closed tail,
// an independent graphic above, and a distinct larger body below.
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
  if (!valid(first) || !/^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*\s+with\b/u.test(first.text))
    return
  const leading = first.y - start.y,
    tail = []
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
      (captionKind(row.text) && row !== first)
    )
      break
    tail.push(row)
    if (/[.!?]$/u.test(row.text.trim()) && row.right - row.x < (start.right - start.x) * 0.8) break
  }
  if (
    tail.length < 2 ||
    tail.length > 10 ||
    !/[.!?]$/u.test(tail.at(-1).text.trim()) ||
    tail.at(-1).right - tail.at(-1).x >= (start.right - start.x) * 0.8 ||
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
  if (!valid(after) || after.y - bbox[3] < em || after.fontSize < em * 1.15) return
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
    !provesFragmentedCaptionGraphic(start, runs, page, last)
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
  if (
    !first ||
    first.y - start.y < em * (referenceContinuation ? 1.15 : 1.6) ||
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
      !(centered ? Math.abs(center(line) - center(start)) < em : Math.abs(line.x - first.x) < 2)
    )
      break
    tail.push(line)
  }
  if (!tail.length || (hanging && tail.length < 2) || !closedLine(tail.at(-1))) return
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
export function applyRuledCaptionRecovery(captions, ruledCaptions, page, rules) {
  const ordinal = (text) =>
    /^(?:Legend to\s+)?(?:Fig(?:ure)?\.?|Chart)\s+([A-Z]?\d+(?:[.-]\d+)*|[A-Z]\.\d+(?:\.\d+)*)(?=[.:\s]|$)/i.exec(
      text
    )?.[1]
  for (const candidate of captions.filter((c) => c.page === page.pageNumber)) {
    const kind = captionKind(candidate.lines[0])
    if (!['table', 'figure'].includes(kind)) continue
    const matches = ruledCaptions.filter((c) => {
      if (c.page !== candidate.page || captionKind(c.lines[0]) !== kind) return false
      if (kind === 'table')
        return (
          (c.lines[0] === candidate.lines[0] ||
            (c.lines[0].replaceAll('ˆ', '') === candidate.lines[0].replaceAll('ˆ', '') &&
              recoverNativeRaisedCaptionFragments(page, c, rules))) &&
          c.rect[1] === candidate.rect[1] &&
          (Math.abs(c.rect[0] - candidate.rect[0]) < 0.01 ||
            (c.rect[0] <= candidate.rect[0] + 0.01 && c.rect[2] >= candidate.rect[2] - 0.01))
        )
      const key = ordinal(candidate.lines[0])
      return (
        key &&
        ordinal(c.lines[0]) === key &&
        Math.abs(c.rect[0] - candidate.rect[0]) < 0.1 &&
        Math.abs(c.rect[1] - candidate.rect[1]) < 0.1
      )
    })
    if (matches.length === 1) Object.assign(candidate, matches[0])
  }
}

// Some legends print their first line slightly larger than the remaining
// paragraph. Recover only a closed, flush, uniformly spaced smaller-font tail
// beside an independently proved graphic; do not widen the generic font gate.
function findNativeSmallerFigureCaption(start, runs, page) {
  if (
    captionKind(start.text) !== 'figure' ||
    start.text.length < 35 ||
    /[.!?]$/.test(start.text.trim()) ||
    start.right - start.x < page.width * 0.35
  )
    return
  const em = start.fontSize
  const following = runs
    .filter(
      (l) =>
        l.y > start.y + em * 0.2 &&
        l.y - start.y < em * 14 &&
        Math.abs(l.x - start.x) <= em * 0.2 &&
        l.right <= start.right + em * 0.2
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const first = following[0]
  if (
    !first ||
    first.fontSize < em * 0.86 ||
    first.fontSize > em * 0.94 ||
    Math.abs(first.x - start.x) > em * 0.2 ||
    first.y < start.y + em * 0.95 ||
    first.y - start.y > em * 1.4 ||
    first.right > start.right + em * 0.2
  )
    return
  const tail = []
  for (const line of following) {
    const previous = tail.at(-1) ?? start
    if (
      Math.abs(line.fontSize - first.fontSize) > em * 0.02 ||
      Math.abs(line.x - start.x) > em * 0.2 ||
      line.right > start.right + em * 0.2 ||
      line.y < previous.y + first.fontSize * 0.95 ||
      line.y - previous.y > em * 1.4 ||
      (tail.length && Math.abs(line.y - previous.y - first.fontSize * 1.11) > em * 0.2) ||
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
    tail.length < 2 ||
    !/[.!?]$/.test(last.text.trim()) ||
    last.right - last.x >= (start.right - start.x) * 0.98 ||
    tail.slice(0, -1).some((l) => l.right - l.x < (start.right - start.x) * 0.85)
  )
    return
  const singleGraphic = (page.graphicsBounds ?? []).some((g) => {
    if (g.kind !== 'image' && g.kind !== 'path') return false
    const r = (g.paintedNormalizedRect ?? g.normalizedRect).map(
      (v, n) => v * (n % 2 ? page.height : page.width)
    )
    return (
      r[0] >= start.x - em &&
      r[2] <= start.right + em &&
      r[2] - r[0] >= (start.right - start.x) * 0.75 &&
      (r[2] - r[0]) * (r[3] - r[1]) > page.width * page.height * 0.04 &&
      r[3] <= start.y + em * 0.1 &&
      start.y - r[3] < em * 3
    )
  })
  if (
    !singleGraphic &&
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

// Complete independently closed native caption rows retain their source fonts and literals.
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
      ({ text, ...line }) =>
        captionKind(text) ||
        /^Table\s+\d+\.\s*$/i.test(text.trim()) ||
        hasNearbyBareFigureGraphic({ text, ...line }) ||
        isNativePhotographCaption(
          { text, ...line },
          runs,
          page,
          separators.get(page.pageNumber) ?? []
        )
    )) {
      if (ownedRuns.has(start)) continue
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
      // A reference wrapped after "listed in" is part of the same paragraph.
      // Require its preceding source line, matching typography and tight leading.
      if (
        (/^Table\s+\d+\s+for\s+[a-z]/.test(start.text) ||
          /^(?:(?:Supplementary|Supplemental)\s+)?(?:(?:Figure|Fig\.)\s+\d+|Table\s+(?:\d+|[IVXLCDM]+))[.:]\s+[A-Z]/.test(
            start.text
          )) &&
        runs.some(
          (line) =>
            (/(?:\b(?:listed|shown|provided|presented|reported|displayed|conditions) in|\bbetween conditions,|\bin (?:Supplemental|Supplementary)|\b(?:Supplementary |Supplemental )?(?:Table|Figure|Fig\.) \d+ and)$/.test(
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
      const nativeParagraph =
        findNativeInternalReferenceParagraph(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? []
        ) ??
        panelParagraph ??
        boundedParagraph?.tail ??
        findNativeSingleSpacedCaptionParagraph(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? []
        ) ??
        findNativeCenteredFigureParagraph(start, runs, page) ??
        findNativeMathCaptionParagraph(start, runs, page, separators.get(page.pageNumber) ?? []) ??
        findNativeClosedOutdentedFigureCaption(
          start,
          runs,
          page,
          rulesByPage.get(page.pageNumber) ?? []
        ) ??
        findNativeCaptionParagraph(start, runs, page, separators.get(page.pageNumber) ?? []) ??
        findNativeMixedLegend(start, page) ??
        findNativeTwoThirdFigureCaption(start, runs, page) ??
        findNativeSmallerFigureCaption(start, runs, page)
      const lines = [boundedParagraph?.first ?? start, ...(nativeParagraph ?? [])]
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
        const internalReference =
          next &&
          lines.length >= 3 &&
          captionKind(start.text) === 'figure' &&
          /\b(?:discussed|shown|described|reported|illustrated|explained)(?:\s+further)?\s+in$/i.test(
            previous.text.trim()
          ) &&
          /^(?:Fig\.?|Figure)\s+[A-Z]?\d+(?:\.\d+)*[.:]\s+\p{L}/u.test(next.text) &&
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
                : centeredTitle || spacedFigureTail
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
                y0 <= next.y + next.fontSize * 0.1 &&
                x0 <= start.x + 2 &&
                x1 >= Math.max(previous.right, next.right) - 2
            ))
        )
          break
        lines.push(next)
        if (internalReference) ownedRuns.add(next)
      }
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
      if (nativeParagraph) for (const line of lines) ownedRuns.add(line)
      candidates.push(candidate)
    }
  }
  return candidates
}
