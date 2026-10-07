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
      c.rect[0] >= frame[0] - 0.1 &&
      c.rect[2] <= frame[2] + 0.1
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
  // Appendix ordinals have a letter followed by a decimal number. Classify
  // the whole printed ordinal before the Roman-label path can mistake C.1
  // for table C. The source text is never rewritten.
  const appendix =
    /^(Table|Tab\.?|Fig\.?|Figure|Chart)\s+[A-Z]\.\d+(?:\.\d+)*(?=[\s.:)]|$)(.*)$/i.exec(text)
  if (appendix) {
    const tail = appendix[2]
    if (
      /^\)/.test(tail) ||
      /^[,:]\s+(?:we|our)\s+(?:show|present|compare|evaluate|report|describe|visuali[sz]e|plot)\b/i.test(
        tail
      ) ||
      /^[.:]\s+(?:Therefore|Thus),?\b/i.test(tail) ||
      /^\s+(?:and\s+(?:Table|Tab\.?|Fig\.?|Figure|Chart)\s+[A-Z]\.\d+(?:\.\d+)*\s+)?(?:reports?|reported|shows?|shown|presents?|presented|illustrat(?:es?|ed)|visuali[sz](?:es?|ed)|plots?|gives?|follows?|ablates?|sweeps?|tests?|evaluates?|compares?|depict(?:s|ed)?|represents?|contains?|lists?|summari[sz](?:e(?:s|d)?|ing)|indicates?|suggests?|describes?|demonstrates?|preserves?|grounds?|defines?|makes?|sets?|adds?|complements?|uses?(?=\s+(?:one|a|an|the|our|this|these|those|its|their|\d+)\b)|in\s+(?:the\s+)?(?:Appendix|Supplement(?:ary)?|Section|ESM))\b/i.test(
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
  // Panel references in running prose are often emitted as a standalone line
  // (for example, "Fig. 6 (b) illustrates ...").  The panel marker used to
  // hide the finite verb from the reference guard below, so these lines could
  // be mistaken for captions and steal a neighbouring figure crop.  Keep
  // punctuation-delimited titles eligible while rejecting one or more labels
  // followed by a finite verb.  The repeated-label form also covers prose
  // such as "Table 1 and Table 2 report ...".
  const narrativeReferenceLabel =
    '(?:(?:Supplementary|Supplemental)\\s+)?(?:Table|Tab\\.?|Chart|Fig\\.?|Figure)\\s+(?:[A-Z]?\\d+(?:\\.\\d+)?|[A-Z]\\.\\d+|[IVXLCDM]+)'
  const narrativeReferencePanel =
    '(?:\\s*\\((?:[A-Za-z]|left|right|top|bottom|middle|center|centre)\\)(?:\\s*(?:,|and|&)\\s*\\((?:[A-Za-z]|left|right|top|bottom|middle|center|centre)\\))*)?'
  const narrativeReferenceVerb =
    '(?:is|are|was|were|has|have|had|shows?|shown|presents?|presented|compares?|compared(?=\\s+(?:the|these|those|this|that|our)\\b)|reports?|reported|confirms?|reveals?|illustrat(?:es?|ed)|visuali[sz](?:es?|ed)|analy[sz](?:es?|ed)|provides?|plots|gives?|follows?|splits?|separates?|breaks?|lists?|decomposes?|contains?|depict(?:s|ed)?|represents?|reiterates?|reviews?|summari[sz](?:e(?:s|d)?|ing)|indicates?|suggests?|describes?|demonstrates?|displays?|exhibits?|achieves?|carr(?:y|ies|ied)|extends?|preserves?|grounds?|defines?|makes?|sets?|adds?|complements?|uses?(?=\\s+(?:one|a|an|the|our|this|these|those|its|their|\\d+)\\b)|examines?|var(?:y|ies|ied)|evaluates?|isolates?|paves?|introduces?)'
  const narrativeReference = new RegExp(
    `^${narrativeReferenceLabel}${narrativeReferencePanel}(?:\\s*(?:,|and|&)\\s*${narrativeReferenceLabel}${narrativeReferencePanel})*\\s+(?:(?:also|further)\\s+)?${narrativeReferenceVerb}\\b`,
    'i'
  )
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
  if (
    /^(?:fig\.?|figure)\s+[A-Z]?\d+\s+(?:for|in|as|when|where|since|because|to|the|this|these|those|however|therefore|thus)\b/i.test(
      text ?? ''
    )
  )
    return undefined
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

export function groupPageLines(page) {
  const rows = []
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
    /^(?:(?:Supplementary|Supplemental)\s+)?(?:Table|Tab\.?|Figure|Fig\.?)\s+(?:[A-Z]?\d+(?:[.-]\d+)*|[IVXLCDM]+)(?=[\s.:：．、。]|$)/i.test(
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
  const owned = []
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
    const prefix = page.lines.some(
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
    owned.push({
      text: retained.trim(),
      x: Math.min(start.x, parts[0].x),
      y: row.y,
      right: Math.max(...parts.map((l) => l.x + l.width)),
      bottom: Math.max(...parts.map((l) => l.y + l.height)),
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
  if (math.length < 2 || !provesFragmentedCaptionGraphic(start, runs, page, owned.at(-1))) return
  return owned.slice(1)
}

// Centered publisher prose has a stable native center, not a stable left
// edge. Require a complete connected block and its independently painted
// graphic; neither indentation nor a closed sentence alone proves ownership.
function provesSingleCaptionRaster(start, runs, page) {
  const em = start.fontSize
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image')
    .map((g) => g.normalizedRect.map((v, axis) => v * (axis % 2 ? page.height : page.width)))
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[0] >= start.x - em &&
        r[2] <= start.right + em &&
        r[1] < r[3] &&
        r[2] > r[0] &&
        r[3] <= start.y + em * 0.1 &&
        start.y - r[3] < em * 6 &&
        (r[2] - r[0]) * (r[3] - r[1]) > page.width * page.height * 0.04 &&
        r[2] - r[0] > (start.right - start.x) * 0.5
    )
  if (images.length !== 1) return false
  const image = images[0]
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
    !/^(?:Fig\.?|Figure\.?)\s+[A-Z]?\d+(?:[.-]\d+)*[.:]?\s/u.test(start.text) ||
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
    const runs = groupPageLines(page)
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
        hasNearbyBareFigureGraphic({ text, ...line })
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
            Math.abs(line.x - start.x) <= 2 &&
            Math.abs(line.fontSize - start.fontSize) <= 0.5 &&
            line.y + Math.min(line.bottom - line.y, line.fontSize) <= start.y &&
            start.y - line.bottom <=
              start.fontSize * (captionKind(start.text) === 'figure' ? 1.5 : 0.5)
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
        /^(?:Figure|Fig\.?|Table|Tab\.?)\s+(?:[A-Z]?\d+(?:\.\d+)*|[A-Z]\.\d+(?:\.\d+)*|[IVXLCDM]+)\.\s*$/i.test(
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
      const nativeParagraph =
        findNativeCenteredFigureParagraph(start, runs, page) ??
        findNativeMathCaptionParagraph(start, runs, page, separators.get(page.pageNumber) ?? []) ??
        findNativeCaptionParagraph(start, runs, page, separators.get(page.pageNumber) ?? []) ??
        findNativeMixedLegend(start, page) ??
        findNativeSmallerFigureCaption(start, runs, page)
      const lines = [start, ...(nativeParagraph ?? [])]
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
            const tails = runs.filter(
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
