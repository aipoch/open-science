/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  captionKind,
  joinCaptionLines,
  groupPageLines,
  findOutdentedParagraphContinuation
} from './literature-pdf-caption-group.mjs'
import { union, intersection, lineRect } from './literature-pdf-page-geometry.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import {
  findDoubleSpacedNoteBlocks,
  isNotePageMargin,
  recoverRuledFooterNotes,
  recoverRuledReferenceNotes,
  recoverExplicitDefinitionParagraphs,
  recoverCenteredRuledGlossaries,
  recoverNativeNumberedDefinitionFooter
} from './literature-pdf-note-blocks.mjs'

// Text-only classifiers are shared across pages; source ownership and
// consumed-line state remain local to each association call below.
const symbolDefinitions = (text) =>
  /^[α-ωΑ-Ω]\s+\p{L}/u.test(text.trim()) &&
  (text.match(/,\s*[A-Z]{2,4}\s+[a-z]/g) ?? []).length >= 3
const doseDefinition = (text) =>
  /^All doses (?:are )?given as percentage of the prescribed dose to the [\p{L} /-]{3,60}(?:[.,]|$)/iu.test(
    text.trim()
  )
const doseTargetDefinition = (text) =>
  /^Inclusion of level ([IVX]+|\d+) corresponds to [≥>]\s*\d+(?:\.\d+)?\s*% of level \1 included in the delineated$/i.test(
    text.trim()
  )
const medianProportionDefinition = (text) =>
  /^Values are median \(q1,\s*q3\) or number \(proportion\)\.$/i.test(text.trim())
const boldGroupDefinition = (text) =>
  /^Boldness indicate significant group differences \(P\s*[<≤]\s*0?\.\d+\);\s*\*Adjusted for baseline value;/i.test(
    text.trim()
  )
const singleEquationKey = (text) =>
  /^(?:Legend:\s*)?([A-Z][A-Z0-9-]{1,11})\s*=\s*\p{Ll}[\p{L} -]{3,79}\.$/u.exec(text.trim())?.[1]
const statisticDefinition = (text) =>
  doseDefinition(text) ||
  doseTargetDefinition(text) ||
  medianProportionDefinition(text) ||
  boldGroupDefinition(text) ||
  !!singleEquationKey(text) ||
  /^(?:Uncorrected|Multiplicity[- ]adjusted|Adjusted) p[- ]?values\.$/i.test(text.trim()) ||
  /^Data are presented as (?:mean\s*\(SD\)|median\s*\(IQR\))(?:[;,. ]|$)/i.test(text.trim()) ||
  /^Maximum score possible was \d+(?:\.\d+)?\. Data are presented as (?:mean\s*\(SD\)|median\s*\(IQR\))\.$/i.test(
    text.trim()
  ) ||
  /^Values are numbers?\s*\(proportions?\)\.?$/i.test(text.trim()) ||
  /^[A-Z]{2,8}=\p{L}[^.]{2,80}\.\s*\*Estimated at \d+ years?\b.*[†‡][^.]+test\./u.test(
    text.trim()
  ) ||
  // Explicit statistical formats are notes regardless of the order of the
  // count and median terms. Ownership and paragraph boundaries are checked below.
  /^Data are (?:n(?:\/N)?\s*\(%\)|medians?\s*\((?:IQR|interquartile range)\))(?=[.;, ]|$)/i.test(
    text.trim()
  ) ||
  /^[^.!?]{3,160} were evaluated as a continuous variable\. [^.!?]{3,160} were evaluated as a categorical variable\.$/i.test(
    text.trim()
  ) ||
  /^Values are (?:presented|shown) as (?:mean\s*±\s*(?:SD|standard deviation)(?: or (?:number|n)\s*\(%\))?|median\s*\(Q1,\s*Q3\))\./i.test(
    text.trim()
  ) ||
  /^Data (?:are )?(?:expressed|presented|reported) as medians? \((?:interquartile range|IQR)\)(?=[.,; ]|$)/i.test(
    text.trim()
  ) ||
  /^Values are (?:given as |frequencies or )?medians? \(minimum[–-]maximum\)(?: and means?)?\./i.test(
    text.trim()
  ) ||
  /^(?:Numbers|Values) represent (?:least[- ]square[ds]? )?means? \(standard errors?\)(?=[;. ]|$)/i.test(
    text.trim()
  ) ||
  /^Data (?:are )?expressed as mean\s*±\s*standard deviation\b/i.test(text.trim()) ||
  /^Mean \(standard deviation\);\s*(?:chi-square|Fisher|Student|Tukey)\b/i.test(text.trim()) ||
  /^(?:Mixed|Repeated[- ]measures) ANOVA;.*\bvalues are expressed as mean\b/i.test(text.trim()) ||
  /^Fixed effects were\b.+\b(?:dependent variable|random effects)\b/i.test(text.trim()) ||
  /^Standard errors (?:in|appear in) parentheses\./i.test(text.trim()) ||
  /^Data are numbers? of (?:patients|participants)\s*\(%\)(?:[,.]|$)/i.test(text.trim()) ||
  /^These are (?:coefficients|(?:the average |estimated )?marginal effects) from [\p{L} -]+ (?:regressions|models)\. Standard errors\b/iu.test(
    text.trim()
  ) ||
  /^Values are medians? except those in parenthes(?:is|es), which are minimum to maximum\.?$/i.test(
    text.trim()
  ) ||
  // The spelled-out statistic establishes the note even if the source uses
  // an unfamiliar abbreviation. Recognition must not rewrite that spelling.
  /^Data (?:are )?reported as mean\s*±\s*(?:SD|standard (?:deviation|error)(?: \([A-Z]{2,8}\))?)(?:[;,.]|$)/i.test(
    text.trim()
  ) ||
  /^Values are means?\s*±\s*SD(?:[;,.]|$)/i.test(text.trim()) ||
  /^Valid percent was reported\.?$/i.test(text.trim()) ||
  /^(?:Subjective|Behavioral) sleep data was derived from\b.*\*p\s*[<≤]\s*0?\.\d+/i.test(
    text.trim()
  ) ||
  /^SDs are reported (?:in parenthes[ei]s|to the right of the mean in parentheses)\b/i.test(
    text.trim()
  ) ||
  /^Data are (?:median \(interquartile range\) or percentage \(%\)|numbers or Odds Ratio \(OR\))\./i.test(
    text.trim()
  ) ||
  /^(?:Baseline\s+)?Data are means?\s*±\s*SD(?:[;,.]|$)/i.test(text.trim()) ||
  /^(?:All )?values are expressed as (?:the )?(?:number|n)\s*\(%\) and mean\s*±\s*SD\.?$/i.test(
    text.trim()
  )
const abbreviationPrefix = (text) =>
  /^[A-Z][A-Z0-9.‐‑-]*(?: [A-Z]{2,4})?[:,]\s*\p{L}/u.test(text) ||
  /^[A-Z]{2,8}\s+indicates\s+\p{L}/u.test(text)
const abbreviationLabel = (text) =>
  /^(?:Ab?breviations?|Abbr(?:ev)?\.?)\s*[:：]/i.test(text.trim()) ||
  (/^Abbreviations\s+[^:：]{3,100}[:：]/i.test(text.trim()) &&
    (text.match(/(?:[:：;]\s*)[A-Z][A-Za-z.]{1,12}[—–]\s*\p{L}/gu) ?? []).length >= 2) ||
  // A transposed source label is still a glossary only when its content
  // independently supplies multiple explicit acronym/definition pairs.
  (/^Abbreviaitons?\s*[:：]/i.test(text.trim()) &&
    (text.match(/(?:[:：;]\s*)[A-Z][A-Z0-9-]{1,7},\s*\p{L}/gu) ?? []).length >= 2)
const comparisonNote = (text) =>
  /^Compared (?:with|to) (?:the )?[\p{L}\d -]{1,60} group,\s*p\s*[=<>≤≥]\s*(?:0?\.\d+|1(?:\.0+)?)\.?$/iu.test(
    text.trim()
  )
// Expansion-first keys need several explicit acronym pairs, not parenthesized
// measurements or one ordinary prose definition.
const expandedDefinitions = (text) => {
  const pairs = [
    ...text
      .trim()
      .matchAll(
        /(?:^|;\s*)\p{L}[\p{L} /–-]{1,79}\s+\((?=[A-Za-z -]*[A-Z])[A-Za-z][A-Za-z -]{1,15}\)(?=[;,.]|$)/gu
      )
  ]
  return pairs.length >= 3 && pairs[0].index === 0
}
// Commas and periods may separate colon definitions as well as semicolons.
// Require multiple acronym keys; ordinary section headings are not a glossary.
const colonDefinitions = (text) => {
  // A multiline glossary may put the entire definition list in parentheses.
  // Strip only its outer punctuation for recognition; output keeps the source.
  text = text.trim().replace(/^\(/, '').replace(/\)$/, '')
  if (!/^[A-Z][A-Za-z0-9.+-]{0,7}:\s*\p{L}/u.test(text.trim())) return false
  const pairs = [...text.trim().matchAll(/(?:^|[;,.]\s+)([A-Za-z][A-Za-z0-9.+-]{0,7}):\s*\p{L}/gu)]
  return pairs.length >= 3 && pairs.filter((p) => /^[A-Z]{2,8}$/.test(p[1])).length >= 2
}
const dottedDefinitions = (text) =>
  [...text.trim().matchAll(/(?:^|;\s*)([A-Z][A-Za-z]{1,11})\.\s*=\s*\p{L}/gu)].map((m) => m[1])
const definitionList = (text) =>
  dottedDefinitions(text).length >= 3 ||
  expandedDefinitions(text) ||
  // A publisher may omit both the glossary label and key punctuation.
  // Require at least three complete uppercase-key/lowercase-expansion pairs.
  /^(?:[A-Z]{2,8}\s+\p{Ll}[\p{L}\s-]+,\s*){2,}[A-Z]{2,8}\s+\p{Ll}[\p{L}\s-]+\.?$/u.test(
    text.trim()
  ) ||
  (/^[A-Z0-9][A-Za-z0-9 -]{0,12}[—–]\s*\p{L}/u.test(text.trim()) &&
    (text.match(/(?:^|;\s*)[A-Z0-9][A-Za-z0-9 -]{0,12}[—–]\s*\p{L}/gu) ?? []).length >= 2) ||
  /^(?:[+^#$&]\s*\p{L}[\p{L}\s%-]*(?:\([\p{L}\d\s%.-]+\))?(?:,\s*|$)){3,}$/u.test(text.trim()) ||
  (/^[A-Z][A-Za-z0-9-]{1,7}\s*=\s*\p{L}/u.test(text.trim()) &&
    (text.match(/(?:^|[;,]\s*)[A-Z][A-Za-z0-9-]{1,7}\s*=\s*\p{L}/gu) ?? []).length >= 2) ||
  (/^[\p{L}][\p{L}\d+-]{1,11};\s*\p{L}/u.test(text.trim()) &&
    (text.match(/(?:^|,\s*)[\p{L}][\p{L}\d+-]{1,11};\s*\p{L}/gu) ?? []).length >= 3)
const sourceCredit = (text) =>
  /^Data (?:taken|adapted|reproduced) from \[\d+(?:\s*[,–-]\s*\d+)*\]\.$/i.test(text.trim()) ||
  /^[A-Z][a-z]+\. .{20,}\. [A-Z][^.]+ (?:19|20)\d{2}\.$/.test(text.trim())
const changeDefinition = (text) =>
  /^[∆Δ]\s+(?:represents|denotes|indicates) the change\b/i.test(text.trim())
const commaDefinitions = (text) => {
  const pairs = [
    ...text
      .trim()
      .matchAll(/(?:^|;\s*|\.\s+)([A-Za-z0-9][A-Za-z0-9.-]{0,11}(?: [A-Z]{2,4})?),\s*\p{L}/gu)
  ]
  return (
    pairs.length >= 3 &&
    pairs[0].index === 0 &&
    pairs.filter((p) => (p[1].match(/[A-Z]/g) ?? []).length >= 2).length >= 2
  )
}
const startsNote = (text) =>
  /^Notes?(?:\s*[—–]\s*\p{L}|\.\s*\([a-z]\)\s*\p{L})/iu.test(text.trim()) ||
  /^Notes?\.\s*[+–−-]{1,3}\s*=\s*\p{L}/iu.test(text.trim()) ||
  /^(?:Values are r coefficients from correlation analyses\.|Generalized estimating equations? \(GEE\)|Multivariable analysis performed controlling for|Presented as mean\s*±\s*standard error\b)/i.test(
    text.trim()
  ) ||
  /^Data are mean \((?:SD|95%\s*CI)\)(?:[;. ]|$)/i.test(text.trim()) ||
  /^[A-Z]{2,8}\s+[–—-]\s+\p{L}[\p{L}\s-]+\.\s*[a-z]?\s*Independent samples\b/u.test(text.trim()) ||
  /^Low \(\+\)\s*0%[-–]25%;\s*moderate \(\+\+\)\s*25%[-–]50%;\s*high \(\+\+\+\)/i.test(
    text.trim()
  ) ||
  /^Nominal \(type of surgery, treatments, complications\) and ordinal/.test(text.trim()) ||
  /^Bold indicates a significance level of\s+p\s*[<≤]\s*0?\.\d+\.?$/i.test(text.trim()) ||
  /^Data are mean \(SD\) or n \(%\), unless otherwise specified\./i.test(text.trim()) ||
  abbreviationLabel(text) ||
  commaDefinitions(text) ||
  /^(?:[*⁎†‡§¶‖＊＃#]|(?:Footnotes?|Notes?|Annotations?|Sources?)\s*[:：]|注\s*[:：]|註\s*[:：])/i.test(
    text.trim()
  ) ||
  sourceCredit(text) ||
  changeDefinition(text) ||
  /^P[- ]?values? represent comparisons?\b/i.test(text.trim()) ||
  /^Data from (?:the )?(?:two|both) groups were pooled before analysis\.$/i.test(text.trim()) ||
  /^\+\s*Standard deviation(?:[;,.]|$)/i.test(text.trim()) ||
  /^Notes?\.$/i.test(text.trim()) ||
  /^(?:Notes?|NOTES?)\.?\s+(?:[＊*†‡＃#]\s*)?\p{Lu}/u.test(text.trim()) ||
  /^Notes?\.\s*[—–-]\s*\p{L}/iu.test(text.trim()) ||
  // Named bibliographic sources can omit the usual Note: prefix.
  /^Modified from\s+\p{Lu}.*\b(?:18|19|20)\d{2}\b/u.test(text.trim()) ||
  /^No\.\s*=\s*number\b/i.test(text.trim()) ||
  /^NS\s*[:;,]\s*(?:not\s+|non[- ]?)significant\b/i.test(text.trim()) ||
  (/^[A-Z][A-Z0-9-]*:\s*n\s*=\s*\d+/.test(text.trim()) &&
    (text.match(/\bn\s*=\s*\d+/g) ?? []).length >= 2 &&
    /\bNS:\s*not\s+significant\.?$/i.test(text.trim())) ||
  (/^[A-Z][A-Z0-9-]*\s*\(\s*baseline\b/i.test(text.trim()) &&
    (text.match(/\bn\s*=\s*\d+/g) ?? []).length >= 3) ||
  // Unnumbered abbreviation keys below a table need several explicit pairs;
  // a single acronym in ordinary prose does not establish a table note.
  (/^[A-Z][A-Z0-9.‐‑-]*[:,]\s*\p{L}/u.test(text.trim()) &&
    (text.match(/(?:^|;\s*)[A-Z][A-Z0-9.‐‑-]*[:,]\s*\p{L}/gu) ?? []).length >= 3) ||
  (/^[A-Z]{2,8}\s+indicates\s+\p{L}/u.test(text.trim()) &&
    (text.match(/;\s*[A-Z][A-Za-z0-9/’'.-]{1,11}(?: ratio)?,\s*\p{L}/gu) ?? []).length >= 2) ||
  colonDefinitions(text) ||
  definitionList(text) ||
  /^T\s*\d+-T\s*\d+ was measured between T\s*\d+ and T\s*\d+\./i.test(text.trim()) ||
  (/^MD:\s*mean difference;/i.test(text.trim()) &&
    /95% CI:\s*95% confidence interval;/i.test(text)) ||
  /^(?:The pretreatments in the \d+ phases were|Data are given as geometric mean)\b/i.test(
    text.trim()
  ) ||
  /^Fisher[’']s exact test\.$/i.test(text.trim()) ||
  /^(?:Reported data (?:of|from)|Statistics according to) (?:Fisher[’']s exact|Student[’']s t|Mann[–-]Whitney(?: U)?|chi[–-]square|χ[²2]) test\./i.test(
    text.trim()
  ) ||
  (/^(?:AUC[\d–∞a-z]*|APA)\b/.test(text.trim()) &&
    /(?:area under the|apalutamide, BCRP)/i.test(text)) ||
  /^Different superscript letters indicate significant difference\b/i.test(text.trim()) ||
  /^Values are mean \(SD\), number \(proportion\), or median \[q1, q3\]\./i.test(text.trim()) ||
  /^A significance level of <0\.01 was chosen considering multiple testing\./i.test(text.trim()) ||
  statisticDefinition(text) ||
  /^Data (?:are )?represented as n\s*\(%\) or mean\s*\(SD\)\./i.test(text.trim()) ||
  /^Comparisons between the two study groups were performed using the Student[’']s\b/i.test(
    text.trim()
  ) ||
  /^(?:Data (?:are )?presented as|Estimates are presented as)\s/i.test(text.trim()) ||
  /^.{5,100}\bare expressed as mean\s*±\s*standard deviation\b/i.test(text.trim()) ||
  /^Data are n\s*\(\s*%\s*,\s*95% CI\)\./i.test(text.trim()) ||
  /^Values are (?:number|n)\s*\(%\) unless otherwise indicated\.?$/i.test(text.trim()) ||
  /^Values are presented as (?:number|n)\s*\(%\)(?: unless otherwise indicated)?(?:\.|$)/i.test(
    text.trim()
  ) ||
  symbolDefinitions(text) ||
  (/^[A-Z]{2,5}\s+\d{2,3},/.test(text.trim()) &&
    (text.match(/(?:^|;\s*)[A-Z]{2,5}\s+\d{2,3},\s*\d+\s*mg\/m/gu) ?? []).length >= 3)

// A page-top symbol block before a new table can finish the preceding table's
// footnotes. Every symbol must be raised, cited and previously undefined;
// prior page-end notes, matching typography and a complete bounded block are
// independent ownership witnesses. Reuse the normal note/URL line assembler.
function continuedSymbolNotes(table, page, nextPage, cells) {
  const cited = new Set(
    cells.flatMap((cell) =>
      (cell.textRuns ?? [])
        .filter((run) => run.position === 'superscript')
        .map((run) => run.text.trim())
    )
  )
  const prior = (table.notes ?? []).filter(
    (note) => (!note.page || note.page === page.pageNumber) && /^[*†‡§¶‖#]+\s/.test(note.text)
  )
  if (
    prior.length < 2 ||
    prior.at(-1).rect[3] < page.height * 0.8 ||
    prior.some((note) => !cited.has(/^\S+/.exec(note.text)[0]))
  )
    return []
  const lines = groupPageLines({
    ...nextPage,
    lines: nextPage.lines.filter((line) => !isNotePageMargin(line, nextPage))
  }).sort((a, b) => a.y - b.y || a.x - b.x)
  const title = lines.find((line) => captionKind(line.text))
  const before = /^Table\s+([A-Z]?)(\d+)\b/i.exec(table.caption?.text ?? '')
  const after = /^Table\s+([A-Z]?)(\d+)\b/i.exec(title?.text ?? '')
  if (!before || !after || before[1] !== after[1] || Number(after[2]) !== Number(before[2]) + 1)
    return []
  const prefix = lines.filter((line) => line.bottom <= title.y)
  const starts = prefix.filter((line) => /^\*{1,4}\s+(?:\p{L}|https?:\/\/)/u.test(line.text))
  if (
    starts.length < 2 ||
    prefix[0] !== starts[0] ||
    starts[0].y > nextPage.height * 0.15 ||
    prefix.at(-1).bottom > nextPage.height * 0.3 ||
    title.y - prefix.at(-1).bottom < starts[0].fontSize * 2 ||
    Math.abs(starts[0].x / nextPage.width - prior.at(-1).rect[0] / page.width) > 0.01
  )
    return []
  const height = starts[0].fontSize
  const last = prior.at(-1).rect
  const priorFont = Math.max(
    ...page.lines
      .filter(
        (line) =>
          line.x >= last[0] - 1 &&
          line.x + line.width <= last[2] + 1 &&
          line.y >= last[1] - 1 &&
          line.y + line.height <= last[3] + 1
      )
      .map((line) => line.fontSize)
  )
  if (
    Math.abs(priorFont - height) > 0.7 ||
    groupPageLines({
      ...page,
      lines: page.lines.filter((line) => !isNotePageMargin(line, page))
    }).some(
      (line) =>
        line.y > last[3] + 1 &&
        !(
          /^\d+$/.test(line.text) &&
          line.y > page.height * 0.85 &&
          line.right - line.x < page.width * 0.03 &&
          line.bottom - line.y < page.height * 0.02 &&
          Math.abs((line.x + line.right) / 2 - page.width / 2) < page.width * 0.03
        )
    ) ||
    prefix.some((line) => Math.abs(line.fontSize - height) > 0.7) ||
    starts.some((line, index) => {
      const marker = /^\*+/.exec(line.text)[0]
      return (
        marker.length !== index + 1 ||
        !cited.has(marker) ||
        (table.notes ?? []).some((note) => note.text.startsWith(marker + ' ')) ||
        Math.abs(line.x - starts[0].x) > 2 ||
        !nextPage.lines.some(
          (part) =>
            part.text === marker &&
            Math.abs(part.x - line.x) < 1 &&
            Math.abs(part.y - line.y) < 2 &&
            part.fontSize < height * 0.8 &&
            part.y + part.height < line.bottom - height * 0.15
        )
      )
    })
  )
    return []
  const right = (table.cropRect[2] / 1.5 / page.width) * nextPage.width
  const notes = associateTableNotes(nextPage, [
    { rect: [starts[0].x, starts[0].y - height, right, starts[0].y - 0.1] }
  ])[0]
  if (
    notes.length !== starts.length ||
    notes.some((note, index) => !note.text.startsWith('*'.repeat(index + 1) + ' ')) ||
    prefix.some(
      (line) =>
        !notes.some(
          (note) =>
            line.x >= note.rect[0] - 1 &&
            line.right <= note.rect[2] + 1 &&
            line.y >= note.rect[1] - 1 &&
            line.bottom <= note.rect[3] + 1
        )
    ) ||
    notes.at(-1).rect[3] >= title.y
  )
    return []
  return notes.map((note) => ({ ...note, page: nextPage.pageNumber }))
}

// Notes-only continuations need cited raised markers or an explicit matching
// title. Symbol blocks before the next table retain the original source page.
export function associateContinuedTableNotes(table, page, nextPage) {
  if (!nextPage || nextPage.pageNumber !== page.pageNumber + 1) return []
  const cells = (table.parts ?? [table]).flatMap((part) => part.cells ?? [])
  const symbols = continuedSymbolNotes(table, page, nextPage, cells)
  if (symbols.length) return symbols
  const glossary = continuedGlossaryNotes(table, page, nextPage, cells)
  if (glossary.length) return glossary
  const blocks = findDoubleSpacedNoteBlocks(nextPage)
  const numbered = (table.notes ?? []).filter((n) => /^\d+\s+\p{L}/u.test(n.text))
  if (
    blocks.length >= 2 &&
    numbered.length >= 2 &&
    numbered.every(
      (note, n) =>
        !n || Number(/^\d+/.exec(note.text)[0]) === Number(/^\d+/.exec(numbered[n - 1].text)[0]) + 1
    ) &&
    blocks[0].number === Number(/^\d+/.exec(numbered.at(-1).text)[0]) + 1 &&
    blocks[0].lines[0].y < nextPage.height * 0.15 &&
    numbered.at(-1).rect[3] > page.height * 0.8 &&
    Math.abs(blocks[0].lines[0].x / nextPage.width - numbered.at(-1).rect[0] / page.width) < 0.01 &&
    blocks.filter((b) =>
      cells.some((c) =>
        (c.textRuns ?? []).some(
          (r) => r.position === 'superscript' && r.text.trim() === String(b.number)
        )
      )
    ).length >= 2 &&
    groupPageLines({
      ...nextPage,
      lines: nextPage.lines.filter((l) => !isNotePageMargin(l, nextPage))
    }).every((l) => blocks.some((b) => b.lines.some((p) => p.text === l.text && p.y === l.y)))
  )
    return blocks.map((b) => ({
      text: joinCaptionLines(b.lines.map((l) => l.text)),
      rect: union(b.lines.map((l) => [l.x, l.y, l.right, l.bottom])),
      page: nextPage.pageNumber
    }))
  const number = /^Table\s+([A-Z]?\d+)\b/i.exec(table.caption?.text ?? '')?.[1]
  if (!number) return []
  const titles = groupPageLines(nextPage).filter((line) => {
    const match = /^Table\s+([A-Z]?\d+)\s*[.:]?\s*\(?(?:continued|cont\.?|contd\.?)\)?\.?$/i.exec(
      line.text.trim()
    )
    return match && match[1].toLowerCase() === number.toLowerCase()
  })
  if (titles.length !== 1) return []
  const title = titles[0],
    left = (table.cropRect[0] / 1.5 / page.width) * nextPage.width,
    right = (table.cropRect[2] / 1.5 / page.width) * nextPage.width
  if (title.y > nextPage.height * 0.15 || Math.abs(title.x - left) > 12) return []
  const cited = new Set(
    cells.flatMap((cell) =>
      (cell.textRuns ?? []).flatMap((run) =>
        run.position === 'superscript' && /^[a-z](?:,[a-z])*$/.test(run.text.trim())
          ? run.text.trim().split(',')
          : []
      )
    )
  )
  if (cited.size < 2) return []
  const notes = associateTableNotes(nextPage, [{ rect: [left, title.y, right, title.bottom] }])[0]
  if (
    notes.length < 2 ||
    notes[0].rect[1] - title.bottom > title.fontSize * 2 ||
    notes.at(-1).rect[3] > nextPage.height * 0.4 ||
    notes.some((note, index) => {
      const marker = /^([a-z])\s+\p{L}/u.exec(note.text)?.[1]
      return (
        !marker ||
        !cited.has(marker) ||
        (index > 0 && marker.charCodeAt(0) !== notes[index - 1].text.charCodeAt(0) + 1)
      )
    })
  )
    return []
  return notes.map((note) => ({ ...note, page: nextPage.pageNumber }))
}

// Manuscript tables can end just before a notes-only page without repeating
// their caption. Cited glossary keys and a uniform, aligned, bounded block are
// independent witnesses; a page containing ordinary body prose is ineligible.
function continuedGlossaryNotes(table, page, nextPage, cells) {
  if (!cells.length || table.cropRect[3] / 1.5 < page.height * 0.75) return []
  const centeredFooter = (l, p) =>
    /^\d+$/.test(l.text) &&
    l.y > p.height * 0.85 &&
    l.right - l.x < p.width * 0.03 &&
    l.bottom - l.y < p.height * 0.02 &&
    Math.abs((l.x + l.right) / 2 - p.width / 2) < p.width * 0.03
  const lines = groupPageLines({
    ...nextPage,
    lines: nextPage.lines.filter((l) => !isNotePageMargin(l, nextPage))
  })
    .filter((l) => !centeredFooter(l, nextPage))
    .map((l) => ({ ...l, width: l.right - l.x, height: l.bottom - l.y }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  if (
    !lines.length ||
    lines.length > 16 ||
    lines[0].y > nextPage.height * 0.15 ||
    lines.at(-1).bottom > nextPage.height * 0.45 ||
    lines.some((l) => captionKind(l.text))
  )
    return []
  const first = lines[0],
    height = first.fontSize
  const prior = (table.notes ?? []).filter((n) => !n.page || n.page === page.pageNumber)
  const end = Math.max(table.cropRect[3] / 1.5, ...prior.map((n) => n.rect[3]))
  if (
    groupPageLines(page).some(
      (l) => l.y > end && !isNotePageMargin(l, page) && !centeredFooter(l, page)
    )
  )
    return []
  const left = ((prior.at(-1)?.rect[0] ?? table.cropRect[0] / 1.5) / page.width) * nextPage.width
  if (
    Math.abs(first.x - left) > height * 1.25 ||
    lines.some(
      (l, n) =>
        Math.abs(l.x - first.x) > 2 ||
        Math.abs(l.fontSize - height) > 0.7 ||
        (n && (l.y - lines[n - 1].y < height * 1.8 || l.y - lines[n - 1].y > height * 2.5))
    )
  )
    return []
  const words = new Set(cells.flatMap((c) => c.text.split(/[^A-Za-z0-9-]+/)))
  const formula = /^[*†‡]?\s*([A-Z])x,\s*percent volume receiving\s*[≥>]\s*x\s*Gy\.$/i.exec(
    first.text
  )
  if (
    formula &&
    lines.length === 1 &&
    prior.some((n) => abbreviationLabel(n.text)) &&
    prior.at(-1).rect[3] > page.height * 0.75 &&
    [...words].filter((w) => new RegExp(`^${formula[1]}\\d+$`).test(w)).length >= 2 &&
    cells.some((c) =>
      (c.textRuns ?? []).some((r) => r.position === 'superscript' && r.text === '*')
    )
  ) {
    return [{ text: first.text, rect: lineRect(first), page: nextPage.pageNumber }]
  }
  if (!abbreviationLabel(first.text)) return []
  const start = lines.findIndex((l, n) => n && /^[*†‡]/.test(l.text))
  const definitions = start < 0 ? lines : lines.slice(0, start)
  const text = joinCaptionLines(definitions.map((l) => l.text))
  const keys = [...text.matchAll(/(?:^|[:;]\s*)([A-Z][A-Za-z0-9-]{1,11}),\s*\p{L}/gu)].map(
    (m) => m[1]
  )
  if (
    keys.length < 4 ||
    new Set(keys.filter((key) => words.has(key))).size < 3 ||
    definitions.some((l, n) => n && startsNote(l.text))
  )
    return []
  const notes = [{ text, rect: union(definitions.map(lineRect)), page: nextPage.pageNumber }]
  if (start >= 0) {
    const body = lines.slice(start),
      marker = body[0].text[0]
    if (
      body.length > 4 ||
      body.slice(1).some((l) => startsNote(l.text)) ||
      !/[.]$/.test(body.at(-1).text) ||
      !cells.some((c) =>
        (c.textRuns ?? []).some((r) => r.position === 'superscript' && r.text === marker)
      )
    )
      return []
    notes.push({
      text: joinCaptionLines(body.map((l) => l.text)),
      rect: union(body.map(lineRect)),
      page: nextPage.pageNumber
    })
  }
  return notes
}

// Repair only fragments of already accepted notes. Native glyph adjacency and
// a unique owned anchor keep nearby prose and ordinary numbers out of the note.
function reconcileInlineNoteFragments(page, notes) {
  const raw = page.lines
  const owned = (note, part) =>
    part.x >= note.rect[0] - part.fontSize * 0.1 &&
    part.x + part.width <= note.rect[2] + part.fontSize * 0.1 &&
    part.y >= note.rect[1] - part.fontSize * 0.1 &&
    part.y + part.height <= note.rect[3] + part.fontSize * 0.1
  for (const script of raw) {
    const reference = /^\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]$/.test(script.text)
    if (!reference && !/^[A-Za-z]$/.test(script.text)) continue
    const anchors = raw.filter((body) => {
      const rise = body.y + body.height - script.y - script.height
      const gap = script.x - body.x - body.width
      return (
        body !== script &&
        body.text.trim().length >= 12 &&
        /\p{L}/u.test(body.text) &&
        (reference ? /[.;:]$/.test(body.text.trim()) : /\p{L}$/u.test(body.text.trim())) &&
        script.fontSize <= body.fontSize * 0.8 &&
        rise >= body.fontSize * 0.2 &&
        rise <= body.fontSize * 0.8 &&
        script.y < body.y + body.fontSize * 0.2 &&
        gap >= -body.fontSize * 0.1 &&
        gap <= body.fontSize * 0.3
      )
    })
    if (anchors.length !== 1) continue
    const anchor = anchors[0]
    const recipients = notes.filter(
      (note) => owned(note, anchor) && note.text.includes(anchor.text.trim())
    )
    if (recipients.length !== 1) continue
    const note = recipients[0]
    if (reference) {
      // Do not steal a reference which already belongs to another accepted note.
      if (notes.some((other) => owned(other, script) && other.text.includes(script.text))) continue
      const text = anchor.text.trim()
      if (note.text.split(text).length !== 2) continue
      note.text = note.text.replace(text, text + ' ' + script.text)
      note.rect = union([note.rect, lineRect(script)])
      continue
    }
    const tails = raw.filter(
      (part) =>
        /^[,;:.]$/.test(part.text) &&
        Math.abs(part.y - anchor.y) <= anchor.fontSize * 0.1 &&
        Math.abs(part.fontSize - anchor.fontSize) <= anchor.fontSize * 0.1 &&
        part.x - script.x - script.width >= -anchor.fontSize * 0.1 &&
        part.x - script.x - script.width <= anchor.fontSize * 0.3 &&
        owned(note, part) &&
        owned(note, script)
    )
    if (tails.length !== 1) continue
    const text = anchor.text.trim() + ' ' + script.text + ' ' + tails[0].text
    if (note.text.split(text).length !== 2) continue
    // Keep the source letter verbatim; geometry does not prove a degree symbol.
    note.text = note.text.replace(text, anchor.text.trim() + script.text + tails[0].text)
  }
}

// Crop only the padded sliver crossing an already-owned dose definition. The
// last cell glyphs and one matching native closing edge must precede that note;
// any clipped body/header text keeps the original crop diagnostic.
export function recoverRuledDoseNoteCrop(table, notes, rules) {
  const doseNotes = notes.filter((note) => doseDefinition(note.text))
  if (doseNotes.length !== 1 || table.unassigned?.length) return
  const source = (table.cells ?? []).flatMap((cell) => cell.sourceRects ?? [])
  if (!source.length) return
  const bottom = Math.max(...source.map((rect) => rect[3]))
  const height = Math.max(...source.map((rect) => rect[3] - rect[1]))
  const note = doseNotes[0],
    crop = table.cropRect
  if (
    note.rect[1] <= bottom ||
    note.rect[1] >= crop[3] ||
    note.rect[3] <= crop[3] ||
    crop[3] - note.rect[1] > height ||
    Math.abs(note.rect[0] - crop[0]) > height ||
    note.rect[2] > crop[2] + 2
  )
    return
  if (
    (table.clipped ?? []).some(
      (item) =>
        item.rect[0] < note.rect[0] - 0.1 ||
        item.rect[1] < note.rect[1] - 0.1 ||
        item.rect[2] > note.rect[2] + 0.1 ||
        item.rect[3] > note.rect[3] + 0.1
    )
  )
    return
  const measuredRows = new Set(
    (table.cells ?? [])
      .filter((cell) => cell.column > 0 && /^\d/.test(cell.text.trim()) && cell.sourceRects?.length)
      .map((cell) => cell.row)
  )
  if (measuredRows.size < 2) return
  const edges = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[1] >= bottom &&
      r[1] < note.rect[1] &&
      r[1] - bottom < height &&
      note.rect[1] - r[1] < height &&
      Math.abs(r[0] - crop[0]) < height &&
      Math.abs(r[2] - crop[2]) < height
  )
  if (!edges.length || edges.at(-1)[1] - edges[0][1] > height * 0.15) return
  return [crop[0], crop[1], crop[2], edges.at(-1)[1]]
}

// A cited, one-line equation can sit in a padded narrative-table crop. The
// complete source ink and a native closing border must delimit it before the
// crop changes; another clipped item or ambiguous source stays diagnostic.
export function recoverRuledDefinitionNoteCrop(table, notes, rules) {
  const definitions = notes.filter((n) => singleEquationKey(n.text))
  if (definitions.length !== 1 || table.unassigned?.length) return
  const note = definitions[0],
    crop = table.cropRect
  const source = (table.cells ?? []).flatMap((c) => c.sourceRects ?? [])
  if (
    !source.length ||
    !(table.cells ?? []).some(
      (c) =>
        c.text.split(/[^A-Za-z0-9-]+/).includes(singleEquationKey(note.text)) &&
        c.sourceRects?.length
    )
  )
    return
  const bottom = Math.max(...source.map((r) => r[3]))
  const height = Math.max(...source.map((r) => r[3] - r[1]))
  if (
    note.rect[1] <= bottom ||
    note.rect[3] <= crop[3] ||
    Math.abs(note.rect[1] - crop[3]) > height ||
    Math.abs(note.rect[0] - crop[0]) > height ||
    note.rect[2] > crop[2] ||
    new Set(table.cells.filter((c) => c.sourceRects?.length).map((c) => c.row)).size < 2
  )
    return
  if (
    (table.clipped ?? []).some((item) =>
      item.rect.some((v, n) => (n < 2 ? v < note.rect[n] - 0.1 : v > note.rect[n] + 0.1))
    )
  )
    return
  const edges = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[1] >= bottom &&
      r[1] < note.rect[1] &&
      r[1] < crop[3] &&
      r[1] - bottom < height &&
      note.rect[1] - r[1] < height &&
      Math.abs(r[0] - crop[0]) < height &&
      Math.abs(r[2] - crop[2]) < height
  )
  if (!edges.length || edges.at(-1)[1] - edges[0][1] > height * 0.15) return
  return [crop[0], crop[1], crop[2], edges.at(-1)[1]]
}

// Note ownership uses actual cell ink when every in-crop native token has
// exactly one cell owner. A recovered last row can extend to a closing stroke
// inside its quantized path box; that row padding is not additional body text.
// This note-only region never changes caption bounds, the grid or the crop.
function ownsMeasuredSourcePartitions(source, native, observedRuns) {
  if (!observedRuns?.length) return false
  const close = (a, b) => Math.abs(a - b) < 1e-9
  const assigned = new Map(native.map((i) => [i, []]))
  for (const rect of source) {
    const owners = native.filter(
      (i) =>
        close(rect[1], i.rect[1]) &&
        close(rect[3], i.rect[3]) &&
        rect[0] >= i.rect[0] - 1e-9 &&
        rect[2] <= i.rect[2] + 1e-9
    )
    if (owners.length !== 1) return false
    assigned.get(owners[0]).push(rect)
  }
  for (const [item, parts] of assigned) {
    if (!parts.length) return false
    if (parts.length === 1 && parts[0].every((v, i) => close(v, item.rect[i]))) continue
    const matching = observedRuns.filter(
      (r) =>
        r.text === item.text &&
        r.rect?.length === 4 &&
        r.rect.every((v, i) => Number.isFinite(v) && close(v, item.rect[i])) &&
        Number.isFinite(r.baseline) &&
        Number.isFinite(r.height) &&
        r.height > 0 &&
        close(r.baseline, item.baseline) &&
        close(r.height, item.height)
    )
    if (matching.length !== 1) return false
    const run = matching[0]
    if (
      !Array.isArray(run.literalGlyphs) ||
      !Array.isArray(run.glyphRuns) ||
      run.literalGlyphs.length !== run.glyphRuns.length ||
      !run.glyphRuns.every(Number.isInteger) ||
      run.literalGlyphs.some((g) => typeof g !== 'string') ||
      run.literalGlyphs.join('').replace(/\s/gu, '') !== item.text.replace(/\s/gu, '')
    )
      return false
    const glyphCount = Array.from(run.literalGlyphs.join('').replace(/\s/gu, '')).length
    const gaps = run.gaps ?? []
    if (
      !gaps.length ||
      gaps.some(
        (g) =>
          ![g.left, g.right, g.index].every(Number.isFinite) ||
          !(g.right > g.left) ||
          !Number.isInteger(g.index) ||
          g.index <= 0 ||
          g.index >= glyphCount
      )
    )
      return false
    parts.sort((a, b) => a[0] - b[0])
    if (!close(parts[0][0], item.rect[0]) || !close(parts.at(-1)[2], item.rect[2])) return false
    for (let i = 1; i < parts.length; i++) {
      if (
        parts[i][0] <= parts[i - 1][2] ||
        gaps.filter((g) => close(g.left, parts[i - 1][2]) && close(g.right, parts[i][0])).length !==
          1
      )
        return false
    }
  }
  return true
}

export function tableNoteOwnershipRect(table, contentRect, scale, pageItems, observedRuns = []) {
  if (!(scale > 0) || !Number.isFinite(scale) || table.unassigned?.length || !pageItems?.length)
    return contentRect
  const crop = table.cropRect,
    source = table.cells?.flatMap((cell) => cell.sourceRects ?? []) ?? []
  if (
    !source.length ||
    !crop?.every(Number.isFinite) ||
    !contentRect?.every(Number.isFinite) ||
    source.some(
      (r) =>
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        r[2] <= r[0] ||
        r[3] <= r[1] ||
        r[0] < crop[0] ||
        r[1] < crop[1] ||
        r[2] > crop[2] ||
        r[3] > crop[3]
    )
  )
    return contentRect
  const keys = new Set(source.map((r) => JSON.stringify(r))),
    native = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.text?.trim() &&
        i.rect[0] >= crop[0] &&
        i.rect[1] >= crop[1] &&
        i.rect[2] <= crop[2] &&
        i.rect[3] <= crop[3]
    ),
    nativeKeys = new Set(native.map((i) => JSON.stringify(i.rect)))
  if (
    keys.size !== source.length ||
    nativeKeys.size !== native.length ||
    ((native.length !== source.length || native.some((i) => !keys.has(JSON.stringify(i.rect)))) &&
      !ownsMeasuredSourcePartitions(source, native, observedRuns))
  )
    return contentRect
  const bottom = Math.max(...source.map((r) => r[3])) / scale
  return bottom > contentRect[1] && bottom < contentRect[3]
    ? [...contentRect.slice(0, 3), bottom]
    : contentRect
}

// A note must begin with a footnote marker or explicit notes label and have one
// nearest preceding table. Continuations retain their original source region.
export function associateTableNotes(page, tables, rules = []) {
  const manuscriptBlocks = findDoubleSpacedNoteBlocks(page)
  const horizontal = joinHorizontalTableRules(rules)
  rules = [...rules.filter((r) => r[1] !== r[3]), ...horizontal]
  const notes = tables.map(() => [])
  const lines = groupPageLines(page)
    // Diagonal publication watermarks have tall rotated bounds; they are not
    // intervening prose. Ordinary horizontal occurrences remain untouched.
    .filter(
      (line) =>
        !(
          line.bottom - line.y > line.fontSize * 2 &&
          /^(?:ACCEPTED (?:MANUSCRIPT|ARTICLE)|JOURNAL PRE[- ]PROOF|PROOF)$/i.test(line.text.trim())
        )
    )
    .map((line) => ({ ...line, width: line.right - line.x, height: line.bottom - line.y }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  // Superscript bibliography numbers can split one footnote baseline into
  // several PDF.js lines. Rejoin only tightly adjacent fragments linked by
  // an actual raised reference; column gaps and ordinary numbers remain intact.
  for (const line of [...lines]) {
    if (
      !lines.includes(line) ||
      /^\d+$/.test(line.text) ||
      !tables.some(({ rect }) => line.y > rect[3] && line.x < rect[2] && line.right > rect[0])
    )
      continue
    const baseline = lines
      .filter(
        (l) =>
          Math.abs(l.y - line.y) < 0.1 &&
          Math.abs(l.fontSize - line.fontSize) < 0.8 &&
          !/^\d+$/.test(l.text)
      )
      .sort((a, b) => a.x - b.x)
    if (baseline.length < 2) continue
    const members = [baseline[0]]
    for (const next of baseline.slice(1)) {
      const previous = members.at(-1)
      const refs = lines.filter(
        (l) =>
          /^\d{1,3}$/.test(l.text) &&
          line.y - l.y > 1 &&
          line.y - l.y < line.fontSize * 0.6 &&
          Math.abs(l.x - previous.right) < 3 &&
          next.x - l.right >= -0.1 &&
          next.x - l.right < line.fontSize * 0.5
      )
      if (refs.length !== 1) break
      members.push(refs[0], next)
    }
    if (members.length < 3) continue
    const merged = {
      ...members[0],
      text: members.map((l) => l.text).join(' '),
      right: members.at(-1).right,
      width: members.at(-1).right - members[0].x,
      items: members.flatMap((l) => l.items ?? [])
    }
    for (const member of members) lines.splice(lines.indexOf(member), 1)
    lines.push(merged)
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x)
  // Raised symbolic/parenthesized markers can occupy a separate grouped
  // baseline. Join only a unique tightly adjoining definition below a table,
  // using the full-size prose baseline for note-block spacing.
  for (const marker of [...lines]) {
    if (!/^(?:[*†‡]{1,3}|[a-z]\))$/.test(marker.text) || !lines.includes(marker)) continue
    const bodies = lines.filter(
      (l) =>
        l !== marker &&
        /^\p{L}/u.test(l.text) &&
        marker.fontSize <= l.fontSize &&
        Math.abs(marker.right - l.x) < l.fontSize * 0.3 &&
        l.bottom - marker.bottom > l.fontSize * 0.2 &&
        l.bottom - marker.bottom < l.fontSize * 0.8 &&
        Math.abs(l.y - marker.y) < l.fontSize * 0.8 &&
        tables.some(
          ({ rect }) =>
            marker.y >= rect[3] - marker.height * 0.5 &&
            marker.y - rect[3] < 36 &&
            marker.x >= rect[0] - 12 &&
            marker.right <= rect[2]
        )
    )
    if (bodies.length !== 1) continue
    const body = bodies[0]
    body.text = marker.text + ' ' + body.text
    body.x = marker.x
    body.y = Math.min(body.y, marker.y)
    body.height = body.bottom - body.y
    body.width = body.right - body.x
    body.items = [...(marker.items ?? []), ...(body.items ?? [])]
    lines.splice(lines.indexOf(marker), 1)
  }
  for (const first of [...lines]) {
    if (!lines.includes(first)) continue
    const next = lines.find(
      (l) =>
        l !== first &&
        /^(?:[a-z]\)|[*†‡]{1,3})\s/.test(l.text) &&
        Math.abs(l.bottom - first.bottom) < 0.1 &&
        Math.abs(l.fontSize - first.fontSize) < 0.1 &&
        l.x >= first.right &&
        l.x - first.right < first.fontSize &&
        tables.some(
          ({ rect }) =>
            first.y >= rect[3] &&
            first.y - rect[3] < 36 &&
            first.x >= rect[0] - 12 &&
            l.right <= rect[2] + 12
        )
    )
    if (!next) continue
    first.text += ' ' + next.text
    first.right = next.right
    first.width = first.right - first.x
    first.items = [...(first.items ?? []), ...(next.items ?? [])]
    lines.splice(lines.indexOf(next), 1)
  }
  const used = new Set()
  const numberedFooters = recoverNativeNumberedDefinitionFooter(page, tables)
  for (const [index, block] of numberedFooters.entries())
    if (block) {
      notes[index].push(...block.notes)
      for (const line of lines)
        if (
          line.x >= block.rect[0] - 0.1 &&
          line.right <= block.rect[2] + 0.1 &&
          line.y >= block.rect[1] - 0.1 &&
          line.bottom <= block.rect[3] + 0.1
        )
          used.add(line)
    }
  const ruledDefinitionKeys = (line, rect) => {
    const keys = dottedDefinitions(line.text)
    if (keys.length < 3) return false
    const words = new Set(
      page.lines
        .filter(
          (l) =>
            l.y >= rect[1] &&
            l.y + l.height <= rect[3] &&
            l.x >= rect[0] - 1 &&
            l.x + l.width <= rect[2] + 1
        )
        .flatMap((l) => l.text.match(/\p{L}+/gu) ?? [])
    )
    return (
      keys.every((k) => words.has(k)) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] <= line.y &&
          line.y - r[1] < line.fontSize &&
          Math.abs(r[1] - rect[3]) < line.fontSize * 2 &&
          Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.85
      )
    )
  }
  const ruledGlossary = (start, rect) =>
    /^(?=[A-Za-z]*[A-Z][A-Za-z]*[A-Z])[A-Za-z]{2,8}[, ]\s*\p{Ll}/u.test(start.text) &&
    start.y >= rect[3] &&
    start.y - rect[3] < start.fontSize * 2 &&
    Math.abs(start.x - rect[0]) < start.fontSize * 1.5 &&
    rules.some(
      (r) =>
        r[1] === r[3] &&
        r[1] > rect[3] &&
        r[1] < start.y &&
        Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.85
    ) &&
    lines.some(
      (next) =>
        /^[*⁎†‡]/.test(next.text) &&
        next.y > start.y &&
        next.y - start.y < start.fontSize * 1.8 &&
        Math.abs(next.x - start.x) < 2 &&
        next.fontSize <= start.fontSize + 0.8 &&
        next.fontSize >= start.fontSize * 0.6
    )
  const wrappedStatistics = (start) => {
    if (!/^[^.!?]{5,100}\b(?:and|of)\s*$/i.test(start.text)) return undefined
    return lines.find(
      (next) =>
        next.y > start.y + 2 &&
        next.y - start.y <= start.fontSize * 1.8 &&
        Math.abs(next.x - start.x) <= 2 &&
        Math.abs(next.fontSize - start.fontSize) <= 0.8 &&
        !tables.some(({ rect }) => intersection(rect, lineRect(next)) > 0) &&
        /^.{5,160}\bare expressed as mean\s*±\s*standard deviation\b/i.test(
          start.text + ' ' + next.text
        )
    )
  }
  const wrappedAbbreviations = (start) => {
    if (!abbreviationPrefix(start.text) && !/^(?:Ae|AUC)[\d–∞ h]*,/.test(start.text)) return false
    const parts = [start]
    for (const next of lines.filter((line) => line.y > start.y + 2)) {
      if (next.right <= start.x || next.x >= start.right) continue
      if (
        parts.length >= 3 ||
        next.x > start.x + 2 ||
        next.x < start.x - start.fontSize * 1.25 ||
        Math.abs(next.fontSize - start.fontSize) > 0.8 ||
        next.y - parts.at(-1).y > start.fontSize * 1.8 ||
        captionKind(next.text)
      )
        break
      parts.push(next)
    }
    return startsNote(parts.map((line) => line.text).join(' '))
  }
  // A repeated isotope prefix is scientific notation, not a numbered note.
  // The same mass/element must occur elsewhere on this page; ordinary raised
  // numeric footnotes retain the existing geometric checks.
  const repeatedIsotope = (line) => {
    const prefix = /^(\d{2,3})\s*(Zr|Tc|F|Cu|Ga|I|Lu|Y|In)[–-]/.exec(line.text)
    return (
      prefix &&
      lines.filter((other) => new RegExp(`\\b${prefix[1]}\\s*${prefix[2]}[–-]`).test(other.text))
        .length >= 2
    )
  }
  const raisedMarker = (line) =>
    !repeatedIsotope(line) &&
    /^(?:[a-zα-ω♉]\)?|\d{1,2}[a-z]?)(?:\s*,)?\s+(?:[—–-]\s*)?(?:\p{L}|\d+[–-]\p{L}|\d+(?:\.\d+)?%?\s+\p{L})/u.test(
      line.text
    ) &&
    page.lines.some(
      (part) =>
        /^(?:[a-zα-ω♉]\)?|\d{1,2}[a-z]?)$/.test(part.text) &&
        Math.abs(part.x - line.x) < 1 &&
        Math.abs(part.y - line.y) < Math.max(2, line.fontSize * 0.5) &&
        part.fontSize < line.fontSize * 0.9 &&
        part.y + part.height < line.bottom - line.fontSize * 0.15
    )
  // A neighboring column can put a raised marker in a different grouped row.
  // Recover only a small letter/symbol tightly adjoining this note on a raised baseline.
  // Correctly decoded Greek/statistical markers need the same ownership proof
  // as legacy Latin slots, or font repair would detach the note from its table.
  const citedFullSizeLetter = (part, line) => {
    if (!/^[a-z]$/.test(part.text) || Math.abs(part.fontSize - line.fontSize) > 0.1) return false
    const owners = tables.filter(
      ({ rect }) =>
        part.y >= rect[3] &&
        part.y - rect[3] < line.fontSize * 8 &&
        part.x >= rect[0] - 1 &&
        part.right <= rect[2] + 1 &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= rect[3] &&
            r[1] <= part.y &&
            Math.abs(r[0] - rect[0]) < line.fontSize &&
            Math.abs(r[2] - rect[2]) < line.fontSize &&
            (part.y - r[1] < line.fontSize ||
              (() => {
                const series = lines
                  .filter(
                    (p) =>
                      /^[a-z]$/.test(p.text) &&
                      p.y >= r[1] &&
                      p.y - r[1] < line.fontSize * 8 &&
                      Math.abs(p.x - part.x) < 0.1 &&
                      Math.abs(p.fontSize - part.fontSize) < 0.1
                  )
                  .sort((a, b) => a.y - b.y)
                const leading = series[1]?.y - series[0]?.y
                return (
                  series.length >= 3 &&
                  series.includes(part) &&
                  series[0].text === 'a' &&
                  series[0].y - r[1] < line.fontSize &&
                  leading > line.fontSize * 1.5 &&
                  leading < line.fontSize * 2.5 &&
                  series.every(
                    (p, i) =>
                      !i ||
                      (p.text.charCodeAt(0) === series[i - 1].text.charCodeAt(0) + 1 &&
                        Math.abs(p.y - series[i - 1].y - leading) < line.fontSize * 0.1)
                  )
                )
              })())
        ) &&
        page.lines.some(
          (mark) =>
            mark.text === part.text &&
            Math.abs(mark.fontSize - part.fontSize) < 0.1 &&
            mark.x >= rect[0] &&
            mark.x + mark.width <= rect[2] &&
            mark.y >= rect[1] - 0.1 &&
            mark.y + mark.height <= rect[3] &&
            page.lines.some(
              (body) =>
                body !== mark &&
                body.text.length > 3 &&
                body.y >= rect[1] &&
                body.y + body.height <= rect[3] &&
                Math.abs(body.fontSize - mark.fontSize) < 0.1 &&
                body.y + body.height - mark.y - mark.height > line.fontSize * 0.2 &&
                body.y + body.height - mark.y - mark.height < line.fontSize * 0.8 &&
                Math.abs(body.x + body.width - mark.x) < line.fontSize
            )
        )
    )
    return owners.length === 1
  }
  const fullSizeBelowTableMarker = (part, line) =>
    part.fontSize >= line.fontSize * 1.02 &&
    part.fontSize <= line.fontSize * 1.1 &&
    tables.some(
      ({ rect }) =>
        part.x >= rect[0] - 1 &&
        part.right <= rect[2] + 1 &&
        part.y >= rect[3] &&
        part.y - rect[3] <= line.fontSize * 6 &&
        line.x >= part.x - 1 &&
        line.x - part.x <= line.fontSize * 1.5 &&
        page.lines.some(
          (caption) =>
            /^(?:Table|Tab\.?)\s+[AS]?\d+[.:]?/i.test(caption.text.trim()) &&
            caption.y < rect[1] &&
            page.lines.some(
              (witness) =>
                witness !== part &&
                witness.text === part.text &&
                witness.y < rect[1] &&
                rect[1] - witness.y <= line.fontSize * 40
            )
        )
    )
  const detachedMarker = (line) =>
    /^(?:\p{L}|\d+[–-]\p{L}|\d+(?:\.\d+)?%?\s+\p{L})/u.test(line.text) &&
    lines.find(
      (part) =>
        !used.has(part) &&
        /^[a-zα-ω♉]$/.test(part.text) &&
        (citedFullSizeLetter(part, line) ||
          part.fontSize < line.fontSize * 0.9 ||
          (part.fontSize > line.fontSize * 1.02 &&
            part.fontSize <= line.fontSize * 1.1 &&
            tables.some(({ rect }) =>
              page.lines.some(
                (mark) =>
                  mark.text === part.text &&
                  mark.y < rect[3] &&
                  ((mark.y >= rect[1] - mark.height && mark.x >= rect[0] && mark.x < rect[2]) ||
                    (rect[1] - mark.y < mark.height * 6 &&
                      mark.y < rect[1] &&
                      lines.some(
                        (c) =>
                          captionKind(c.text) === 'table' &&
                          c.y <= mark.y &&
                          mark.y - c.y < mark.height * 5 &&
                          c.x >= rect[0] - mark.height * 2 &&
                          c.x < rect[2]
                      )))
              )
            )) ||
          // A full-size marker can sit on its own baseline immediately below
          // the table. Require a caption-owned witness above the table and a
          // short aligned gap before accepting the following wrapped line.
          fullSizeBelowTableMarker(part, line)) &&
        (Math.abs(part.right - line.x) < line.fontSize * 0.25 ||
          (part.fontSize >= line.fontSize * 0.9 &&
            part.x < line.x &&
            part.right - line.x >= 0 &&
            part.right - line.x < line.fontSize * 0.5) ||
          // A column can split the marker from its note during line grouping.
          // Wider spacing needs the next raised letter in an aligned series.
          (line.x >= part.right &&
            line.x - part.right < line.fontSize * 0.6 &&
            lines.some(
              (next) =>
                raisedMarker(next) &&
                next.text[0] === String.fromCharCode(part.text.charCodeAt(0) + 1) &&
                Math.abs(next.x - part.x) < 1 &&
                Math.abs(next.fontSize - line.fontSize) < 0.5 &&
                next.y >= line.bottom &&
                next.y - line.y < line.fontSize * 2
            ))) &&
        Math.abs(part.y - line.y) < line.fontSize * 0.8 &&
        line.bottom - part.bottom >= line.fontSize * 0.2 &&
        line.bottom - part.bottom <= line.fontSize * 0.8
    )
  const citedSymbol = (line, rect) => {
    const marker = /^[*†‡§¶‖#∆Δ]/.exec(line.text)?.[0]
    return (
      marker &&
      page.lines.some(
        (part) =>
          part.text.includes(marker) &&
          part.y >= rect[1] &&
          part.y + part.height <= rect[3] &&
          part.x >= rect[0] &&
          part.x + part.width <= rect[2]
      )
    )
  }
  // Two-line notes can touch a manuscript table's bottom rule. Require a
  // comparison or a definition list, with abbreviations cited inside the table,
  // before joining a double-spaced continuation.
  const ruledDefinitionTail = (start, rect) => {
    const comparison =
      /^P\s*[=<>≤≥]\s*(?:0?\.\d+|1(?:\.0+)?)\s+for\b/i.test(start.text) &&
      (start.text.match(/\bp\s*[=<>≤≥]\s*(?:0?\.\d+|1(?:\.0+)?)/gi) ?? []).length === 2
    const definitions = [
      ...start.text.matchAll(/(?:^|;\s*)([A-Z0-9][A-Z0-9-]{1,11})\s*=\s*[a-z0-9]/g)
    ]
    const glossary = definitions.length >= 3 && definitions[0].index === 0
    if ((!comparison && !glossary) || Math.abs(start.y - rect[3]) > start.fontSize * 0.2) return
    const next = lines.find((l) => l.y > start.y + 2 && l.right > start.x && l.x < start.right)
    if (
      !next ||
      !/^[a-z]/.test(next.text) ||
      Math.abs(next.x - start.x) > 2 ||
      Math.abs(next.fontSize - start.fontSize) > 0.7 ||
      next.right > start.right + 2 ||
      next.y - start.y > start.fontSize * 2.5 ||
      next.y - start.y <= start.fontSize * 1.8
    )
      return
    const keys = [...next.text.matchAll(/(?:^|;\s*)([A-Z]{2,8})\s*=\s*\p{L}/gu)].map((m) => m[1])
    const words = page.lines
      .filter(
        (l) =>
          l.y >= rect[1] && l.y + l.height <= rect[3] && l.x >= rect[0] && l.x + l.width <= rect[2]
      )
      .flatMap((l) => l.text.split(/\W+/))
    if (glossary) {
      if (new Set(definitions.map((m) => m[1]).filter((k) => words.includes(k))).size < 2) return
    } else if (new Set(keys).size < 2 || keys.some((k) => !words.includes(k))) return
    return next
  }
  // A two-line labeled glossary may wrap inside its final expansion. Its
  // short terminal line must complete that expansion and supply another cited
  // key; a nearby full-width native closing rule proves the block's ownership.
  const ruledLabeledGlossaryTail = (start, rect) => {
    if (!abbreviationLabel(start.text) || /[.;:]$/.test(start.text)) return
    const keys = [
      ...start.text.matchAll(/(?:[:：;]\s*)([A-Z0-9][A-Z0-9-]{1,11}),\s*[\p{L}\d]/gu)
    ].map((m) => m[1])
    if (
      keys.length < 2 ||
      !rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] >= rect[3] &&
          r[1] - rect[3] < start.fontSize * 1.5 &&
          Math.abs(r[1] - start.y) < start.fontSize * 0.2 &&
          Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.85
      )
    )
      return
    const next = lines.find((l) => l.y > start.y + 2 && l.right > start.x && l.x < start.right)
    if (
      !next ||
      !/^\p{Ll}[\p{Ll} -]{1,39};\s*[A-Z][A-Z0-9-]{1,11},\s*\p{Ll}[\p{L} -]{1,59}\.$/u.test(
        next.text
      ) ||
      Math.abs(next.x - start.x) > 2 ||
      Math.abs(next.fontSize - start.fontSize) > 0.7 ||
      next.width >= start.width * 0.7 ||
      next.y - start.y <= start.fontSize * 1.8 ||
      next.y - start.y > start.fontSize * 2.5
    )
      return
    keys.push(/;\s*([A-Z][A-Z0-9-]{1,11}),/.exec(next.text)[1])
    const words = new Set(
      page.lines
        .filter(
          (l) =>
            l.y >= rect[1] &&
            l.y + l.height <= rect[3] &&
            l.x >= rect[0] &&
            l.x + l.width <= rect[2]
        )
        .flatMap((l) => l.text.match(/[A-Za-z0-9-]+/g) ?? [])
    )
    if (keys.some((key) => !words.has(key))) return
    return next
  }
  const touchesRuledBottom = (line, rect) => {
    if (ruledDefinitionKeys(line, rect)) return true
    if (
      abbreviationLabel(line.text) &&
      line.y <= rect[3] &&
      rect[3] - line.y < line.fontSize &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] <= line.y &&
          line.y - r[1] < line.fontSize &&
          Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.85
      )
    )
      return true
    // The model can include a footer note in its last row. A full-width
    // native closing rule and an explicit statistic definition delimit it.
    if (
      statisticDefinition(line.text) &&
      line.y <= rect[3] &&
      rect[3] - line.y < line.fontSize * 1.5 &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] <= line.y &&
          line.y - r[1] < line.fontSize &&
          Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.85
      )
    )
      return true
    // Only a raised marker may cross a padded crop while its full-size note
    // text starts below it. A nearby full-width closing rule proves ownership.
    if (
      raisedMarker(line) &&
      line.y <= rect[3] &&
      line.y >= rect[3] - line.fontSize * 0.2 &&
      page.lines.some(
        (part) =>
          part.y >= rect[3] &&
          part.y < line.y + line.fontSize * 0.3 &&
          part.fontSize === line.fontSize &&
          Math.abs(part.x - line.x) < line.fontSize
      ) &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] <= line.y &&
          line.y - r[1] < line.fontSize &&
          Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.85
      )
    )
      return true
    // A model's final row can swallow a cited note whose font box touches
    // the native closing rule. Use that rule, not the predicted row bottom.
    if (
      citedSymbol(line, rect) &&
      startsNote(line.text) &&
      line.y <= rect[3] &&
      rect[3] - line.y < line.fontSize * 1.2 &&
      rules.some(
        (r) =>
          r[1] === r[3] &&
          Math.abs(r[1] - line.y) < line.fontSize * 0.2 &&
          Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.85
      )
    )
      return true
    if (
      !(
        raisedMarker(line) ||
        citedSymbol(line, rect) ||
        ruledDefinitionTail(line, rect) ||
        /^Data are mean \(SD\)/.test(line.text)
      ) ||
      line.y > rect[3] ||
      line.y < rect[3] - line.fontSize * 0.2
    )
      return false
    const bottom = rules
      .filter((r) => r[1] === r[3] && Math.abs(r[1] - rect[3]) < 0.5)
      .sort((a, b) => a[0] - b[0])
    return (
      bottom.some(
        (r) => Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.45
      ) ||
      ((citedSymbol(line, rect) || ruledDefinitionTail(line, rect)) &&
        bottom.length > 1 &&
        bottom.every((r, n) => !n || Math.abs(r[0] - bottom[n - 1][2]) < 1) &&
        Math.min(bottom.at(-1)[2], rect[2]) - Math.max(bottom[0][0], rect[0]) >
          (rect[2] - rect[0]) * 0.85)
    )
  }
  const ruledExplanation = (line, rect) => {
    const abbreviation =
      (/^[A-Z]{2,8} [a-z][a-z -]+(?:, [A-Z]{2,8} [a-z][a-z -]+)+\.?$/.test(line.text) ||
        /^[A-Z]{2,8}(?:\s?[a-z])?\s*:\s*\p{Ll}[^:]+\.$/u.test(line.text) ||
        /^[a-z]?[A-Z]{2,8},\s+\p{L}[\p{L}\s-]+\.$/u.test(line.text) ||
        (/^[A-Z][A-Z0-9.‐‑-]*,\s*\p{L}/u.test(line.text) &&
          (line.text.match(/(?:^|;\s*)[A-Z][A-Z0-9.‐‑-]*,\s*\p{L}/gu) ?? []).length >= 2)) &&
      line.width < (rect[2] - rect[0]) * 0.6
    if (
      line.y - rect[3] < 0 ||
      line.y - rect[3] > line.fontSize * 2 ||
      (line.text.split(/\s+/).length < 5 && !abbreviation)
    )
      return false
    const body = lines.filter(
      (other) =>
        other.y >= rect[1] &&
        other.bottom <= rect[3] &&
        other.y > rect[3] - 30 &&
        other.x >= rect[0] &&
        other.right <= rect[2]
    )
    if (!body.length) return false
    const bodySize = Math.min(...body.map((other) => other.fontSize))
    const countedExplanation =
      line.fontSize <= bodySize * 1.05 &&
      (line.text.match(/\(n\s*=\s*\d+\)/gi) ?? []).length >= 2 &&
      body.filter((other) => (other.text.match(/\d+\s*\([\d.]+\)/g) ?? []).length >= 2).length >= 2
    const referenceLocation =
      line.fontSize <= bodySize * 1.05 &&
      (/^(?:The )?(?:reference|source) details\b[^.!?]+\b(?:shown|provided|listed) in (?:Appendix|Supplement(?:ary material)?)\b/i.test(
        line.text
      ) ||
        lines.some(
          (next) =>
            next.y > line.y &&
            next.y - line.y < line.fontSize * 1.8 &&
            Math.abs(next.x - line.x) < 2 &&
            Math.abs(next.fontSize - line.fontSize) < 0.5 &&
            /\bnot included in the (?:above|present) table\.$/i.test(next.text)
        ))
    const definedSubject =
      /^(.{4,60}?) (?:is|are) (?:obtained|calculated|computed|defined)\b/i.exec(line.text)?.[1]
    const normalizeTerm = (s) => s.toLowerCase().replace(/s$/, '').replace(/\s/g, '')
    const headerDefinition =
      definedSubject &&
      line.fontSize <= bodySize * 1.05 &&
      lines.some(
        (l) =>
          l.y >= rect[1] &&
          l.y < rect[1] + line.fontSize * 5 &&
          l.x >= rect[0] &&
          l.right <= rect[2] &&
          normalizeTerm(l.text) === normalizeTerm(definedSubject)
      )
    // Adjustment prose must name a header in this table and remain below its
    // closing rule. An ordinary nearby methods paragraph has no such owner.
    const adjustmentSubject =
      /^([\p{L} -]{2,40}) (?:scores|estimates|means) are adjusted for\b/iu.exec(line.text)?.[1]
    const headerAdjustment =
      adjustmentSubject &&
      line.fontSize <= bodySize * 1.05 &&
      lines.some(
        (l) =>
          l.y >= rect[1] - 0.5 &&
          l.y < rect[1] + line.fontSize * 5 &&
          l.x >= rect[0] &&
          l.right <= rect[2] &&
          ` ${l.text.toLowerCase()} `.includes(` ${adjustmentSubject.trim().toLowerCase()} `)
      )
    const tableDescription =
      (/^This table (?:shows|presents|reports)\b/i.test(line.text) ||
        (/^\p{Lu}.+\bmeasured (?:by|using)\b/u.test(line.text) &&
          lines.some(
            (next) =>
              /^[a-z]\s+(?:Higher|Lower) is better\.?$/.test(next.text) &&
              next.y > line.y &&
              next.y - line.y < line.fontSize * 6 &&
              Math.abs(next.x - line.x) < line.fontSize
          ))) &&
      line.fontSize <= bodySize * 1.05 &&
      body.some((l) => (l.text.match(/\d+(?:\.\d+)?/g) ?? []).length >= 4)
    const statisticalExplanation =
      line.fontSize <= bodySize * 1.05 &&
      /\bp\s*[=<>]\s*0?\.\d+\)/i.test(line.text) &&
      lines.some(
        (next) =>
          symbolDefinitions(next.text) &&
          next.y > line.y &&
          next.y - line.y <= line.fontSize * 1.8 &&
          Math.abs(next.x - line.x) <= 2 &&
          Math.abs(next.fontSize - line.fontSize) <= 0.8
      )
    // A plain introductory sentence can precede a wrapped statistical note.
    // Require both an explicit interval/significance continuation and repeated
    // table terms; nearby body prose without this evidence remains separate.
    const tableTerms = new Set(body.flatMap((l) => l.text.toLowerCase().match(/[a-z]{4,}/g) ?? []))
    const statisticalPreface =
      line.fontSize <= bodySize * 1.05 &&
      new Set((line.text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((s) => tableTerms.has(s)))
        .size >= 2 &&
      lines.some(
        (next) =>
          next.y > line.y &&
          next.y - line.y < line.fontSize * 1.8 &&
          Math.abs(next.x - line.x) < 2 &&
          Math.abs(next.fontSize - line.fontSize) < 0.5 &&
          /(?:\b\d{2}%\s*CI\b|\bconfidence intervals?\b).+\bP\s*[<≤]\s*0?\.\d+/i.test(next.text)
      )
    if (
      line.fontSize >= bodySize * 0.95 &&
      !countedExplanation &&
      !referenceLocation &&
      !statisticalExplanation &&
      !statisticalPreface &&
      !headerDefinition &&
      !headerAdjustment &&
      !tableDescription &&
      !(comparisonNote(line.text) && line.fontSize <= bodySize * 1.05) &&
      !(abbreviation && line.fontSize <= bodySize * 1.05)
    )
      return false
    const borders = rules.filter(
      (r) => Math.abs(r[3] - r[1]) < 1 && r[1] > rect[3] && r[1] < line.y + line.fontSize * 0.2
    )
    return borders.some((border) => {
      const segments = borders
        .filter((r) => Math.abs(r[1] - border[1]) < 1)
        .sort((a, b) => a[0] - b[0])
      return (
        segments.every((r, i) => !i || r[0] - segments[i - 1][2] < 1) &&
        segments.at(-1)[2] - segments[0][0] > (rect[2] - rect[0]) * 0.85 &&
        Math.abs((findOutdentedParagraphContinuation(line, lines)?.x ?? line.x) - segments[0][0]) <
          (abbreviation || headerDefinition || tableDescription || line.fontSize < bodySize * 0.95
            ? line.fontSize
            : 2)
      )
    })
  }
  // A marginal caption can share a column with the table's footnotes. Require
  // an explicit matching source marker or a complete cited abbreviation list,
  // caption alignment and table-height bounds.
  const sideNoteRect = (start, rect) => {
    const marker =
      /^[#*†‡＊＃]\s*\p{L}/u.exec(start.text)?.[0]?.[0] ??
      (raisedMarker(start) ? start.text[0] : undefined)
    if (
      (!marker && !/^[A-Z]{2,8}[,:]?\s+\p{L}/u.test(start.text)) ||
      start.right >= rect[0] - 2 ||
      start.y < rect[1] ||
      start.bottom > rect[3] + start.fontSize * 2
    )
      return
    const caption = lines.find(
      (line) =>
        captionKind(line.text) === 'table' &&
        Math.abs(line.x - start.x) <= 2 &&
        line.right < rect[0] &&
        Math.abs(line.y - rect[1]) <= line.fontSize * 2
    )
    if (!caption) return
    const tableLines = lines.filter(
      (line) =>
        line.x >= rect[0] &&
        line.right <= rect[2] + 1 &&
        line.y >= rect[1] - 2 &&
        line.bottom <= rect[3] + 2
    )
    if (marker) {
      if (
        /^[a-z]$/.test(marker)
          ? !page.lines.some(
              (part) =>
                part.text === marker &&
                part.x >= rect[0] &&
                part.x + part.width <= rect[2] &&
                part.y >= rect[1] - 2 &&
                part.y + part.height <= rect[3] &&
                tableLines.some(
                  (line) =>
                    line.x <= part.x + 1 &&
                    line.right > part.x + part.width &&
                    line.fontSize > part.fontSize * 1.2
                )
            )
          : !tableLines.some((line) => line.text.includes(marker))
      )
        return
    } else {
      // Join only the narrow aligned note column, then verify every explicit
      // acronym/expansion pair against the neighboring table's source text.
      const parts = [start]
      for (const next of lines.filter((line) => line.y > start.y + 2)) {
        if (next.x >= rect[0] || next.right <= start.x) continue
        if (
          next.right >= rect[0] - 2 ||
          Math.abs(next.x - start.x) > 2 ||
          Math.abs(next.fontSize - start.fontSize) > 0.8 ||
          next.y - parts.at(-1).y > start.fontSize * 1.8 ||
          next.bottom > rect[3] + start.fontSize * 2 ||
          captionKind(next.text)
        )
          break
        parts.push(next)
      }
      const text = joinCaptionLines(parts.map((line) => line.text))
      const definitions = text.split(text.includes(';') ? /;\s*|\.\s+(?=[A-Z]{2,8},)/ : /,\s*/)
      const pairs = definitions.map((text) =>
        /^([A-Z][A-Z0-9]{1,7})[,:]?\s+(\p{L}[\p{L}\s/-]*)$/u.exec(text)
      )
      const keys = pairs.map((pair) => pair?.[1])
      const citedInTable = (key) => tableLines.some((line) => line.text.split(/\W+/).includes(key))
      // A two-entry list may define the scale named in the marginal caption.
      // Require a second key in the body and reject dangling uppercase keys
      // masquerading as the end of an incomplete expansion.
      const captionWords = lines
        .filter(
          (line) =>
            Math.abs(line.x - caption.x) <= 2 &&
            line.right < rect[0] &&
            line.y >= caption.y &&
            line.y <= caption.y + caption.fontSize * 4
        )
        .flatMap((line) => line.text.split(/\W+/))
      const shortList =
        keys.length === 2 &&
        pairs.every((pair) => pair && !/\b[A-Z]{2,8}\b/.test(pair[2])) &&
        keys.some(citedInTable)
      if (
        (!shortList && keys.length < 3) ||
        keys.some(
          (key) => !key || (!citedInTable(key) && !(shortList && captionWords.includes(key)))
        )
      )
        return
    }
    return [caption.x, rect[1], rect[0] - 4, rect[3]]
  }
  for (const start of lines) {
    if (used.has(start)) continue
    // A numerator split from its surrounding body sentence is not a numbered
    // footnote. Require the actual short fraction stroke and smaller ink below
    // it; ordinary raised note markers have neither witness.
    const fractionNumerators = page.lines.filter(
      (l) =>
        /^\d{1,2}$/.test(l.text) &&
        Math.abs(l.x - start.x) < 0.1 &&
        Math.abs(l.y - start.y) < 0.1 &&
        l.fontSize <= start.fontSize * 0.8
    )
    if (
      fractionNumerators.some((marker) =>
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[2] - r[0] > 0 &&
            r[2] - r[0] < marker.fontSize * 3 &&
            r[0] <= marker.x + 0.1 &&
            r[2] >= marker.x + marker.width - 0.1 &&
            r[1] - marker.y > marker.fontSize * 0.7 &&
            r[1] - marker.y < marker.fontSize * 1.5 &&
            page.lines.some(
              (l) =>
                l !== marker &&
                /^\d{1,2}$/.test(l.text) &&
                Math.abs(l.fontSize - marker.fontSize) < 0.1 &&
                l.x >= r[0] &&
                l.x + l.width <= r[2] + 0.1 &&
                l.y > marker.y + marker.fontSize * 0.7 &&
                Math.abs(l.y - r[1]) < marker.fontSize * 0.5
            )
        )
      )
    )
      continue
    // A next-column cue is source metadata below the final record. Its centered
    // placement, enclosing bottom rule and neighboring table establish one
    // owner without treating ordinary in-table continuation labels as notes.
    if (/^\(continued in next column\)$/i.test(start.text.trim())) {
      const owners = tables.flatMap(({ rect }, index) =>
        start.y >= rect[3] &&
        start.y - rect[3] < start.fontSize * 2 &&
        Math.abs(start.x + start.right - rect[0] - rect[2]) < start.fontSize * 2 &&
        tables.some(
          ({ rect: next }) => next[0] > rect[2] && Math.abs(next[1] - rect[1]) < start.fontSize * 2
        ) &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= start.bottom &&
            r[1] - start.bottom < start.fontSize &&
            Math.abs(r[0] - rect[0]) < start.fontSize * 2 &&
            Math.abs(r[2] - rect[2]) < start.fontSize * 2
        )
          ? [index]
          : []
      )
      if (owners.length === 1) {
        notes[owners[0]].push({ text: start.text, rect: lineRect(start) })
        used.add(start)
      }
      continue
    }
    const explicitNote = startsNote(start.text)
    if (
      dottedDefinitions(start.text).length >= 3 &&
      !tables.some(({ rect }) => ruledDefinitionKeys(start, rect))
    )
      continue
    // An unmarked definition may follow a block of significance notes. Require
    // its complete subject to name a source row and remain in that note block.
    const definitionSubject = /^(.{4,80}?) (?:includes?|refers? to|denotes?|represents?)\b/i.exec(
      start.text
    )?.[1]
    const normalizeSubject = (text) => text.toLowerCase().replace(/[\s‐‑–-]+/g, '')
    const noteTailDefinitions = tables.map(({ rect }, index) => {
      const previous = notes[index].at(-1)
      return Boolean(
        definitionSubject &&
        previous &&
        start.y >= previous.rect[3] &&
        start.y - previous.rect[3] <= start.fontSize * 1.5 &&
        Math.abs(start.x - previous.rect[0]) < 2 &&
        start.fontSize <= 9 &&
        lines.some(
          (l) =>
            l.y >= rect[1] &&
            l.bottom <= rect[3] &&
            l.x >= rect[0] - 2 &&
            l.right <= rect[2] + 2 &&
            normalizeSubject(l.text.replace(/\s+[−+–-]?(?:\d|\.\d).*$/, '')) ===
              normalizeSubject(definitionSubject)
        )
      )
    })
    const citedDefinitions = tables.map(({ rect }) => {
      const gap = start.y - rect[3]
      // A delimiter-free acronym can expand into comma-separated terms.
      // Initials must spell that acronym; the in-table citation and native
      // closing-rule checks below still establish its owner.
      const expansion = /^([A-Z]{2,8}) (\p{L}[\p{L} -]*(?:, \p{L}[\p{L} -]*)+)\.?$/u.exec(
        start.text
      )
      const commaExpansion =
        expansion &&
        expansion[2]
          .split(', ')
          .map((s) => s.trim()[0].toUpperCase())
          .join('') === expansion[1]
      const ruledSingle =
        (/^[A-Z]{2,8} [\p{L}][\p{L} -]+\.?$/u.test(start.text) || commaExpansion) &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > rect[3] &&
            r[1] < start.y &&
            r[2] - r[0] > (rect[2] - rect[0]) * 0.85
        )
      const singleDefinition =
        ruledSingle ||
        (/^[A-Z][A-Z0-9.‐‑-]{1,11}, [A-Z][a-z].*[.]$/.test(start.text) &&
          start.text.split(/\s+/).length >= 5) ||
        // Acronym definitions often start with a lowercase expansion (for example,
        // `E2, estradiol.`). Nomenclature can include a numbered member. Keep
        // the same closing-rule and in-table citation gates.
        (/^[A-Z][A-Z0-9.‐‑-]{1,7}, \p{Ll}[\p{L}\d\s-]*\.$/u.test(start.text) &&
          start.text.split(/\s+/).length >= 2) ||
        (/^[A-Z]{2,7}s?\s*=\s*\p{L}[\p{L}\s-]*\.$/u.test(start.text) &&
          start.text.split(/\s+/).length >= 4)
      // A source bottom rule can separate a slightly more distant glossary.
      // Keep the original unruled gap limit and require a wide native separator.
      const ruledGap =
        gap <= start.fontSize * 3 &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > rect[3] &&
            r[1] < start.y &&
            ((gap <= start.fontSize * 1.5 &&
              Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.85) ||
              (singleDefinition &&
                start.text.includes('=') &&
                Math.abs(r[0] - rect[0]) < start.fontSize &&
                r[2] - r[0] > (rect[2] - rect[0]) * 0.1 &&
                r[2] - r[0] < (rect[2] - rect[0]) * 0.4))
        )
      if (
        gap < 0 ||
        (gap > start.fontSize + (singleDefinition ? 0.5 : 0) && !ruledGap) ||
        Math.abs(start.x - rect[0]) > 12
      )
        return false
      const pairs = [
        ...start.text.matchAll(/(?:^|;\s*)([A-Za-z][A-Za-z0-9.‐‑-]{0,7})\s*[:,=]\s*\p{L}/gu)
      ]
      if (!pairs.length && /^[A-Z]{2,8} [A-Za-z]/.test(start.text))
        pairs.push(...start.text.matchAll(/(?:^|,\s*)([A-Z]{2,8}) [A-Za-z]/g))
      const words = lines
        .filter(
          (l) =>
            l.y >= rect[1] && l.bottom <= rect[3] && l.x >= rect[0] - 2 && l.right <= rect[2] + 2
        )
        .flatMap((l) => l.text.toLowerCase().split(/[^a-z0-9.‐‑-]+/))
      return (
        (pairs.length >= 2 || (pairs.length === 1 && singleDefinition)) &&
        pairs[0].index === 0 &&
        pairs.every((p) => words.includes(p[1].toLowerCase()))
      )
    })
    if (
      !(
        explicitNote ||
        tables.some(({ rect }) => ruledGlossary(start, rect)) ||
        noteTailDefinitions.some(Boolean) ||
        tables.some(({ rect }) => ruledDefinitionTail(start, rect)) ||
        citedDefinitions.some(Boolean) ||
        tables.some(({ rect }) => sideNoteRect(start, rect)) ||
        wrappedStatistics(start) ||
        wrappedAbbreviations(start) ||
        raisedMarker(start) ||
        detachedMarker(start) ||
        tables.some(({ rect }) => ruledExplanation(start, rect))
      ) ||
      tables.some(
        ({ rect }) =>
          intersection(rect, lineRect(start)) > 0 &&
          // Raised footnote font boxes can cross a native bottom rule slightly.
          // Keep larger overlaps and unruled data inside the table.
          !touchesRuledBottom(start, rect)
      )
    )
      continue
    // A short glossary recognized only through table citations must retain
    // that recipient evidence when nearby tables compete for the same note.
    const requiresCitation = !explicitNote && citedDefinitions.some(Boolean)
    // A continued table can be inset relative to its footnote block. An
    // adjacent, aligned explicit note establishes the block's horizontal
    // ownership without weakening the overlap gate for isolated prose.
    const siblingNote =
      explicitNote &&
      lines.find(
        (line) =>
          line !== start &&
          startsNote(line.text) &&
          Math.abs(line.y - start.y) > 2 &&
          Math.abs(line.y - start.y) < start.fontSize * 1.8 &&
          Math.abs(line.x - start.x) < 2 &&
          Math.abs(line.fontSize - start.fontSize) < 0.8
      )
    const ownershipRight = Math.max(start.right, siblingNote?.right ?? start.right)
    const candidates = tables
      .map(({ rect }, index) => {
        const side = sideNoteRect(start, rect)
        return {
          rect: side ?? rect,
          index,
          gap: side ? 0 : start.y - (notes[index].at(-1)?.rect[3] ?? rect[3])
        }
      })
      .filter(
        ({ rect, gap, index }) =>
          (gap >= 0 ||
            (notes[index].length &&
              (raisedMarker(start) ||
                (/^[*⁎†‡]/.test(start.text) &&
                  Math.abs(start.x - notes[index].at(-1).rect[0]) < 2)) &&
              gap > -start.fontSize * 0.2) ||
            touchesRuledBottom(start, rect)) &&
          (!changeDefinition(start.text) || citedSymbol(start, rect)) &&
          (!requiresCitation || citedDefinitions[index]) &&
          (!noteTailDefinitions.some(Boolean) || noteTailDefinitions[index]) &&
          gap <=
            Math.max(
              36,
              start.fontSize *
                (manuscriptBlocks.some(
                  (b) => b.lines[0].text === start.text && b.lines[0].y === start.y
                ) && colonDefinitions(notes[index].at(-1)?.text ?? '')
                  ? 4
                  : 3)
            ) &&
          (Math.min(rect[2], ownershipRight) - Math.max(rect[0], start.x)) /
            Math.min(rect[2] - rect[0], ownershipRight - start.x) >=
            0.7
      )
      .sort((a, b) => a.gap - b.gap)
    if (!candidates.length || (candidates[1] && candidates[1].gap - candidates[0].gap < 2)) continue
    if (
      medianProportionDefinition(start.text) ||
      boldGroupDefinition(start.text) ||
      singleEquationKey(start.text)
    ) {
      const rect = candidates[0].rect
      const body = page.lines.filter(
        (l) =>
          l.y >= rect[1] &&
          l.y + l.height <= rect[3] &&
          l.x >= rect[0] - 1 &&
          l.x + l.width <= rect[2] + 1
      )
      const words = new Set(body.flatMap((l) => l.text.match(/[A-Za-z0-9-]+/g) ?? []))
      const groupKeys = [...start.text.matchAll(/;\s*([A-Z]{2,8}),(?:\s*\p{L}|\s*$)/gu)].map(
        (m) => m[1]
      )
      if (
        !rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= rect[3] &&
            r[1] <= start.y &&
            start.y - r[1] < start.fontSize &&
            Math.abs(r[0] - rect[0]) < start.fontSize &&
            Math.abs(r[2] - rect[2]) < start.fontSize
        ) ||
        Math.abs(start.x - rect[0]) > start.fontSize ||
        (singleEquationKey(start.text) && !words.has(singleEquationKey(start.text))) ||
        (boldGroupDefinition(start.text) &&
          (groupKeys.length < 2 ||
            groupKeys.some((key) => !words.has(key)) ||
            !body.some((l) => l.text.includes('*')))) ||
        page.lines.some(
          (l) =>
            l.y >= rect[3] &&
            l.y + l.height <= start.y &&
            l.x < rect[2] &&
            l.x + l.width > rect[0] &&
            l.text.trim()
        )
      )
        continue
    }
    if (doseDefinition(start.text)) {
      const rect = candidates[0].rect
      if (
        !rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= rect[3] &&
            r[1] <= start.y &&
            start.y - r[1] < start.fontSize &&
            Math.abs(r[0] - rect[0]) < start.fontSize &&
            Math.abs(r[2] - rect[2]) < start.fontSize
        )
      )
        continue
    }
    // A target-volume criterion is explanatory only beside its already-owned
    // dose-format note. The same sentence in methods prose cannot start a block.
    if (doseTargetDefinition(start.text)) {
      const prior = notes[candidates[0].index].at(-1)
      if (
        !prior ||
        !doseDefinition(prior.text) ||
        Math.abs(prior.rect[0] - start.x) > 1 ||
        start.y < prior.rect[3] ||
        start.y - prior.rect[3] > start.fontSize * 1.8
      )
        continue
    }
    const continuation = wrappedStatistics(start)
    const parts = continuation ? [start, continuation] : [start]
    // Some manuscript footnote digits retain a full-size font box despite a
    // raised baseline. Only attach them to this explicit statistical note.
    const marker = /^Values are (?:number|n)\s*\(%\) unless otherwise indicated\.?$/i.test(
      start.text
    )
      ? lines.find(
          (line) =>
            /^\d$/.test(line.text) &&
            !used.has(line) &&
            line.x <= start.x &&
            start.x - line.x <= start.fontSize &&
            Math.abs(line.right - start.x) <= start.fontSize * 0.5 &&
            start.bottom - line.bottom >= start.fontSize * 0.2 &&
            start.bottom - line.bottom <= start.fontSize * 0.8 &&
            line.y >= candidates[0].rect[3]
        )
      : undefined
    const letter =
      detachedMarker(start) ??
      (/^Fisher[’']s exact test\.$/.test(start.text)
        ? lines.find(
            (part) =>
              /^[a-z]$/.test(part.text) &&
              !used.has(part) &&
              part.x < start.x &&
              start.x - part.x < start.fontSize &&
              Math.abs(part.right - start.x) < start.fontSize * 0.5 &&
              start.y - part.y > start.fontSize * 0.4 &&
              start.y - part.y < start.fontSize * 0.8 &&
              part.fontSize < start.fontSize * 1.1
          )
        : undefined)
    if (letter && letter.y >= candidates[0].rect[3]) {
      parts.unshift(letter)
      used.add(letter)
    }
    if (marker) {
      parts.unshift({ ...marker, text: '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(marker.text)] })
      used.add(marker)
    }
    used.add(start)
    if (continuation) used.add(continuation)
    // Some manuscript abbreviation keys use double-spaced prose. Require two
    // equally spaced continuation lines ending the statement, rather than
    // increasing the gap allowance for all notes and nearby body paragraphs.
    const tail = lines.filter((line) => line.y > start.y + 2).slice(0, 2)
    let doubleSpacedTail =
      /^[*†‡]/.test(start.text) &&
      start.text.length >= 60 &&
      !/[.;:]$/.test(start.text) &&
      tail.length === 2 &&
      /^[a-z]/.test(tail[0].text) &&
      /[.;]$/.test(tail[1].text) &&
      tail.every(
        (line, i) =>
          Math.abs(line.x - start.x) <= 2 &&
          Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
          line.y - (i ? tail[0].y : start.y) > start.fontSize * 1.8 &&
          line.y - (i ? tail[0].y : start.y) <= start.fontSize * 2.5 &&
          Math.abs(line.y - (i ? tail[0].y : start.y) - (tail[0].y - start.y)) <= 1
      )
        ? tail
        : []
    const comparison =
      ruledDefinitionTail(start, candidates[0].rect) ??
      ruledLabeledGlossaryTail(start, candidates[0].rect)
    if (comparison) doubleSpacedTail = [comparison]
    const manuscript = manuscriptBlocks.find(
      (b) => b.lines[0].text === start.text && b.lines[0].y === start.y
    )
    if (manuscript)
      doubleSpacedTail = manuscript.lines
        .slice(1)
        .map((p) => lines.find((l) => l.text === p.text && l.y === p.y))
        .filter(Boolean)
    if (colonDefinitions(start.text) || abbreviationLabel(start.text)) {
      const glossary = []
      let previous = start,
        spacing
      for (const next of lines.filter((l) => l.y > start.y + 2)) {
        const gap = next.bottom - previous.bottom
        if (
          Math.abs(next.x - start.x) > 2 ||
          Math.abs(next.fontSize - start.fontSize) > 0.7 ||
          gap <= start.fontSize * 1.8 ||
          gap > start.fontSize * 2.5 ||
          (spacing !== undefined && Math.abs(gap - spacing) > 1) ||
          (!abbreviationLabel(start.text) &&
            (next.text.match(/(?:^|[,;]\s*)[A-Za-z][A-Za-z.-]{1,7}:\s*\p{L}/gu) ?? []).length <
              2) ||
          (abbreviationLabel(start.text) &&
            (captionKind(next.text) || startsNote(next.text) || !/^[\p{L}\d]/u.test(next.text)))
        )
          break
        spacing ??= gap
        glossary.push(next)
        previous = next
      }
      if (
        glossary.length >= 2 ||
        (glossary.length === 1 &&
          abbreviationLabel(start.text) &&
          /[,;]$/.test(start.text) &&
          /\.$/.test(glossary[0].text))
      )
        doubleSpacedTail = glossary
    }
    // A cited symbol at the bottom rule may introduce a longer manuscript
    // note. Require one uniform double-spaced block with a short final line;
    // unrelated captions, changed indentation and new notes stop the scan.
    if (
      !doubleSpacedTail.length &&
      start.text.length >= 60 &&
      citedSymbol(start, candidates[0].rect) &&
      touchesRuledBottom(start, candidates[0].rect)
    ) {
      const block = []
      let previous = start,
        spacing
      for (const next of lines.filter((line) => line.y > start.y + 2).slice(0, 12)) {
        const gap = next.bottom - previous.bottom
        if (
          Math.abs(next.x - start.x) > 2 ||
          next.right > start.right + 2 ||
          Math.abs(next.fontSize - start.fontSize) > 0.7 ||
          gap <= start.fontSize * 1.8 ||
          gap > start.fontSize * 2.5 ||
          (spacing !== undefined && Math.abs(gap - spacing) > 1) ||
          captionKind(next.text) ||
          startsNote(next.text)
        )
          break
        spacing ??= gap
        block.push(next)
        if (next.width < start.width * 0.7 && /[.;]$/.test(next.text)) {
          if (block.length >= 3) doubleSpacedTail = block
          break
        }
        previous = next
      }
    }
    const outdented = findOutdentedParagraphContinuation(start, lines)
    const wideLabeledFooter =
      /^Notes?\.\s*\([a-z]\)/i.test(start.text) &&
      rules.filter(
        (r) =>
          r[1] === r[3] &&
          r[1] >= candidates[0].rect[3] &&
          r[1] <= start.y &&
          start.y - r[1] < start.fontSize &&
          Math.abs(r[0] - candidates[0].rect[0]) < start.fontSize &&
          Math.abs(r[2] - candidates[0].rect[2]) < start.fontSize
      ).length === 1
    for (const next of lines.filter((line) => line.y > parts.at(-1).y + 2)) {
      // A complete comparison/P-value statement is self-contained.
      if (comparisonNote(start.text) || sourceCredit(start.text)) break
      if (
        next.x >= candidates[0].rect[2] + 4 ||
        next.x + next.width <=
          (wideLabeledFooter
            ? start.x - 1
            : Math.max(candidates[0].rect[0] - 4, start.x - start.fontSize * 2))
      )
        continue
      const previous = parts.at(-1)
      if (doubleSpacedTail.length && previous === doubleSpacedTail.at(-1)) break
      // A short terminal line followed by a first-line indent starts a new
      // paragraph, even when the body uses the same font and line spacing.
      if (
        parts.length > 1 &&
        /[.!?]$/.test(previous.text) &&
        previous.width < start.width * 0.6 &&
        next.x - previous.x >= start.fontSize * 0.8 &&
        next.x >= start.x - 1
      )
        break
      // A wrapped reference can resemble a caption. Keep only a bare reference
      // completing an explicit "in/see Supplementary" phrase; titled captions stop.
      const referenceContinuation =
        (/\b(?:in|see)\s+(?:the\s+)?Supplementary\s*$/i.test(previous.text) ||
          (/^Notes?\./i.test(start.text) && /\bin\s*$/i.test(previous.text))) &&
        /^(?:Table|Fig\.|Figure)\s+S?\d+[a-z]?\.?$/i.test(next.text.trim())
      const standaloneTableLabel =
        /^(?:Table|Tab\.?)\s+(?:[AS]?\d+(?:\.\d+)*|[IVXLCDM]+)\.?$/i.test(next.text.trim())
      // A method name can also start a new note. Here it completes the prior
      // sentence; the usual font, indentation and line-gap checks still apply.
      const methodContinuation =
        /\b(?:using|with|by)\s*$/i.test(previous.text) &&
        /^(?:Fisher[’']s exact|Student[’']s t|Mann[–-]Whitney|chi[–-]square) test\.$/i.test(
          next.text.trim()
        )
      // A single equation may finish an already accepted multi-key glossary.
      // Its new-note classifier must not discard a cited, same-column tail;
      // terminal punctuation, typography and source body evidence delimit it.
      const equationKey = singleEquationKey(next.text)
      const equationGlossaryContinuation =
        equationKey &&
        !/^Legend:/i.test(next.text.trim()) &&
        /;\s*$/.test(previous.text) &&
        /^[A-Z][A-Za-z0-9-]{1,7}\s*=\s*\p{L}/u.test(start.text.trim()) &&
        (start.text.match(/(?:^|[;,]\s*)[A-Z][A-Za-z0-9-]{1,7}\s*=\s*\p{L}/gu) ?? []).length >= 2 &&
        Math.abs(next.x - start.x) <= 2 &&
        Math.abs(next.fontSize - start.fontSize) <= 0.7 &&
        next.right <= start.right + 2 &&
        lines.some(
          (line) =>
            line.y >= candidates[0].rect[1] &&
            line.bottom <= candidates[0].rect[3] &&
            line.x >= candidates[0].rect[0] - 1 &&
            line.right <= candidates[0].rect[2] + 1 &&
            line.text.split(/[^A-Za-z0-9-]+/).includes(equationKey)
        )
      if (
        (startsNote(next.text) &&
          !definitionList(next.text) &&
          !(
            commaDefinitions(next.text) &&
            /;\s*$/.test(previous.text) &&
            wrappedAbbreviations(start)
          ) &&
          !methodContinuation &&
          !equationGlossaryContinuation &&
          !doubleSpacedTail.includes(next)) ||
        raisedMarker(next) ||
        detachedMarker(next) ||
        next.y - previous.y > start.fontSize * (doubleSpacedTail.includes(next) ? 2.5 : 1.8) ||
        Math.abs(next.fontSize - start.fontSize) > 0.8 ||
        next.x <
          (outdented
            ? outdented.x - 1
            : raisedMarker(start) || /^[*⁎†‡§¶‖∆Δ]/.test(start.text)
              ? // An accepted note may start outside an inset table crop. Its own
                // left edge remains a valid continuation boundary.
                Math.min(
                  start.x - 1,
                  Math.max(candidates[0].rect[0] - 2, start.x - start.fontSize * 2)
                )
              : wrappedAbbreviations(start) ||
                  abbreviationLabel(start.text) ||
                  /^Notes?\s*[.:]/i.test(start.text) ||
                  statisticDefinition(start.text)
                ? start.x - start.fontSize * 1.25
                : start.x - 4) ||
        next.x > start.x + 24 ||
        ((captionKind(next.text) || (standaloneTableLabel && !referenceContinuation)) &&
          !referenceContinuation)
      )
        break
      if (tables.some(({ rect }) => intersection(rect, lineRect(next)) > 0)) break
      parts.push(next)
      used.add(next)
    }
    notes[candidates[0].index].push({
      text: joinCaptionLines(parts.map((line) => line.text)),
      rect: union(parts.map(lineRect))
    })
  }
  // A tight publisher frame can enclose a table followed by an unstructured
  // explanatory panel and glossary. Preserve that source panel as notes only
  // when the frame encloses one table and an explicit definition block.
  for (const [index, { rect }] of tables.entries()) {
    if (notes[index].length) continue
    const frames = (page.graphicsBounds ?? [])
      .filter((g) => g.kind === 'path')
      .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)))
      .filter(
        (f) =>
          f[0] <= rect[0] &&
          f[2] >= rect[2] &&
          rect[0] - f[0] < page.width * 0.025 &&
          f[2] - rect[2] < page.width * 0.025 &&
          f[1] < rect[1] &&
          rect[1] - f[1] < 35 &&
          f[3] > rect[3] &&
          f[3] - rect[3] < (rect[3] - rect[1]) * 0.7 &&
          tables.filter((t) => intersection(f, t.rect) > 0).length === 1
      )
    for (const frame of frames.sort((a, b) => a[3] - b[3])) {
      const footer = lines
        .filter(
          (l) =>
            l.y >= rect[3] - 1 &&
            l.bottom < frame[3] - 1 &&
            l.x >= frame[0] + 1 &&
            l.right <= frame[2] - 1
        )
        .sort((a, b) => a.y - b.y || a.x - b.x)
      if (
        footer.length < 3 ||
        footer.length > 12 ||
        footer[0].y - rect[3] > footer[0].fontSize * 2 ||
        !footer.some((l) => definitionList(l.text)) ||
        Math.abs(footer[0].x + footer[0].right - frame[0] - frame[2]) > footer[0].fontSize * 2 ||
        footer.some(
          (l, n) =>
            captionKind(l.text) ||
            l.fontSize > 10 ||
            (n && l.y - footer[n - 1].bottom > l.fontSize * 3)
        )
      )
        continue
      notes[index].push({
        text: joinCaptionLines(footer.map((l) => l.text)),
        rect: union(footer.map(lineRect))
      })
      break
    }
  }
  const footers = recoverRuledFooterNotes(page, tables, rules, lines)
  const references = recoverRuledReferenceNotes(page, tables, rules, lines, notes)
  for (const [index, blocks] of references.entries()) footers[index].push(...blocks)
  const centered = recoverCenteredRuledGlossaries(page, tables, rules, lines)
  for (const [index, blocks] of centered.entries()) footers[index].push(...blocks)
  for (const [index, blocks] of footers.entries()) {
    for (const block of blocks) {
      const prior = notes[index].find(
        (n) =>
          Math.abs(n.rect[1] - block.rect[1]) < 1 &&
          (block.text.startsWith(n.text) || n.text.startsWith(block.text))
      )
      if (prior) {
        if (block.text.length > prior.text.length) Object.assign(prior, block)
      } else if (!notes[index].some((n) => n.text.includes(block.text))) notes[index].push(block)
    }
    notes[index].sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
  }
  reconcileInlineNoteFragments(page, notes.flat())
  const definitionParagraphs = recoverExplicitDefinitionParagraphs(page, tables, notes)
  for (const [index, block] of definitionParagraphs.entries()) {
    if (block)
      Object.assign(
        notes[index].find((n) => /^Notes?:/i.test(n.text)),
        block
      )
  }
  return notes
}
export function recoverRepeatedRecordFooterNotes(page, proof, rules) {
  if (proof?.tables?.length !== 2) return
  const rects = proof.tables.map((t) => t.cropRect.map((v) => v / 1.5)),
    [left, right] = rects
  if (
    left[2] >= right[0] ||
    Math.abs(left[1] - right[1]) > 0.1 ||
    Math.abs(left[3] - right[3]) > 0.1
  )
    return
  for (const rect of rects) {
    const closure = rules.filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - rect[0]) < 0.02 &&
        Math.abs(r[2] - rect[2]) < 0.02 &&
        Math.abs(r[1] - rect[3]) < 0.05
    )
    if (closure.length !== 1) return
  }
  const whole = [left[0], Math.min(left[1], right[1]), right[2], Math.max(left[3], right[3])],
    notes = associateTableNotes(page, [{ rect: whole }], rules)
  if (notes[0].length !== 1) return
  const note = notes[0][0]
  if (!/^Notes?[.:]\s/u.test(note.text) || note.rect[0] > left[2] || note.rect[2] < right[0]) return
  const lines = groupPageLines(page),
    members = lines
      .filter(
        (l) =>
          l.x >= note.rect[0] - 0.01 &&
          l.right <= note.rect[2] + 0.01 &&
          l.y >= note.rect[1] - 0.01 &&
          l.bottom <= note.rect[3] + 0.01
      )
      .sort((a, b) => a.y - b.y)
  if (
    members.length !== 2 ||
    !/^Notes?[.:]\s/u.test(members[0].text) ||
    /^Notes?[.:]\s/u.test(members[1].text) ||
    members.some((l) => Math.abs(l.fontSize - members[0].fontSize) > 0.05) ||
    members[1].y - members[0].bottom < 0 ||
    members[1].y - members[0].bottom > members[0].fontSize * 0.3 ||
    members[0].y - whole[3] < -members[0].fontSize * 0.1 ||
    members[0].y - whole[3] > members[0].fontSize * 0.5
  )
    return
  if (
    lines.some(
      (l) =>
        !members.includes(l) &&
        l.y < note.rect[3] &&
        l.bottom > whole[3] &&
        l.x < whole[2] &&
        l.right > whole[0]
    )
  )
    return
  return [note]
}
