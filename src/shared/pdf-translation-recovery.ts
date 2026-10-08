import { pdfTranslationMissingNumericUnits } from './pdf-translation-numeric-units'
import { isPdfTranslationFailureRetryable, type PdfTranslationCheckpoint } from './pdf-translation'

// Reject unmistakable translation-task commentary, without interpreting or removing
// arbitrary prose. Literal examples already present in the source remain valid.
export function pdfTranslationHasCommentary(source: string, translation: string): boolean {
  const patterns = [
    /\]<\][A-Za-z][\w-]*\[>\[/gu,
    /<\s*\/?\s*(?:source|translation)\s*>/giu,
    /(?:^|\n)\s*(?:User|Assistant|System)\s*[:：]/gu,
    /\b(?:requiredNumericLiterals|retryFeedback|nearbySourceUnits)\b/gu,
    /(?:^|\n)\s*(?:Wait[,!]?\s*)?I need to (?:recheck|correct|rethink|translate)\b[^\n]*/giu,
    /(?:^|\n)\s*Let me (?:correct|recheck|translate)\b[^\n]*/giu,
    /(?:^|\n)\s*The (?:final )?(?:output|translation|answer) should (?:be|preserve|include)\b[^\n]*/giu,
    /(?:^|\n)\s*[（(]?\s*(?:译者注|翻译说明|translation\s+note|translator\s*['’]?s?\s+note)\s*[:：]/giu
  ]
  return patterns.some((pattern) =>
    [...translation.matchAll(pattern)].some((match) => !source.includes(match[0].trim()))
  )
}

// Short fragments must not acquire a neighboring equation when the model tries
// to complete an unfinished sentence. An accented variable copied from context,
// or indexed Greek variable absent from source is a concrete signal.
export function pdfTranslationCopiesNeighborFormula(
  source: string,
  translation: string,
  neighbors: readonly string[]
): boolean {
  const sourceText = source.normalize('NFD'),
    target = translation.normalize('NFD')
  const indices = (value: string): Set<string> =>
    new Set(value.normalize('NFKC').match(/[\p{Script=Greek}]\d+/gu) ?? [])
  const sourceIndices = indices(source),
    targetIndices = indices(translation),
    // Extracted powers can precede subscripts, e.g. γt1 for γ₁ raised to t.
    // Do not infer an absent index from that ambiguous flattened spelling.
    ambiguousBases = new Set(
      [...source.matchAll(/([\p{Script=Greek}])[A-Za-z]+\d/gu)].map((match) => match[1])
    )
  const formulaTokens = (value: string): string[] =>
    value
      .normalize('NFKC')
      .match(
        /(?<![A-Za-z\p{Script=Greek}])[A-Za-z\p{Script=Greek}](?:\s*[=−+*/^]\s*[A-Za-z\p{Script=Greek}\d]+)+/gu
      )
      ?.map((token) => token.replace(/\s/gu, '')) ?? []
  const sourceFormulas = new Set(formulaTokens(source)),
    targetFormulas = new Set(formulaTokens(translation)),
    sourceNumbers = new Set(source.normalize('NFKC').match(/\d+/gu) ?? [])
  return neighbors.some(
    (neighbor) =>
      formulaTokens(neighbor).some(
        (token) => !sourceFormulas.has(token) && targetFormulas.has(token)
      ) ||
      // Incomplete prose next to a separately owned formula must not borrow its
      // leading count. Complete sentences keep the owner's numeric equivalence rules.
      (source.length <= 200 &&
        /[A-Za-z]$/u.test(source.trim()) &&
        /^\s*\d+[)）]/u.test(neighbor) &&
        [...translation.normalize('NFKC').matchAll(/\d+/gu)].some(
          ([value]) => !sourceNumbers.has(value) && neighbor.trimStart().startsWith(value + ')')
        )) ||
      [...neighbor.normalize('NFD').matchAll(/[A-Za-z\p{Script=Greek}]\u0302/gu)].some(
        ([variable]) => !sourceText.includes(variable) && target.includes(variable)
      ) ||
      [...indices(neighbor)].some(
        (variable) =>
          !sourceIndices.has(variable) &&
          !ambiguousBases.has(variable[0]) &&
          targetIndices.has(variable)
      )
  )
}

// Native PDF runs cannot render newly invented TeX commands as mathematics.
// Existing literal TeX in the admitted source remains legitimate document text.
export function pdfTranslationIntroducesMathMarkup(source: string, translation: string): boolean {
  const commands = (text: string): string[] => text.match(/\\(?:[A-Za-z]{2,}|[([])/gu) ?? []
  const existing = new Set(commands(source))
  return commands(translation).some((command) => !existing.has(command))
}

const inlineMathMarkers = (text: string): string[] => {
  const normalized = text.normalize('NFD')
  // Accents inside Latin words (Príncipe, Alcalá) are spelling, not math markers.
  // Standalone decorated variables such as x̂ and ỹ still retain their order.
  const matches = [
    ...normalized.matchAll(/(?:[\p{Script=Greek}][\p{M}]*|[A-Za-z][\p{M}]+)/gu)
  ].filter(
    (match) =>
      /\p{Script=Greek}/u.test(match[0]) ||
      // Noncomposing math accents (x̂y, x̄) remain markers inside products.
      [...match[0].normalize('NFC')].length > 1 ||
      (!/[\p{Script=Latin}\p{M}]/u.test(normalized[match.index - 1] ?? '') &&
        !/[\p{Script=Latin}\p{M}]/u.test(normalized[match.index + match[0].length] ?? ''))
  )
  const groups: string[][] = []
  let previousEnd = 0
  for (const match of matches) {
    const marker = match[0].normalize('NFC')
    const separator = normalized.slice(previousEnd, match.index)
    if (groups.length && /^[\s,;:{}()[\][\]_-]*$/u.test(separator)) groups.at(-1)!.push(marker)
    else groups.push([marker])
    previousEnd = match.index + match[0].length
  }
  return groups.map((group) => group.toSorted().join('|'))
}

// Native PDF formulas are anchored to their surrounding prose. Keep their
// relative order so the writer can reflow the paragraph without leaving the
// original English text behind when a model moves an inline symbol.
export function pdfTranslationReordersInlineMath(source: string, translation: string): boolean {
  const expected = inlineMathMarkers(source)
  const actual = inlineMathMarkers(translation)
  if (expected.length < 2 || expected.length !== actual.length) return false
  const counts = (values: readonly string[]): Map<string, number> =>
    values.reduce(
      (result, value) => result.set(value, (result.get(value) ?? 0) + 1),
      new Map<string, number>()
    )
  const expectedCounts = counts(expected)
  const actualCounts = counts(actual)
  return (
    expectedCounts.size === actualCounts.size &&
    [...expectedCounts].every(([value, count]) => actualCounts.get(value) === count) &&
    expected.some((value, index) => value !== actual[index])
  )
}

// A Greek base with both letter and numeric indices is one mathematical
// identifier. Unicode script styling may change, but no index may disappear.
export function pdfTranslationMissingMathIdentifiers(
  source: string,
  translation: string
): string[] {
  const identifiers = (text: string): string[] =>
    [
      ...text
        .normalize('NFKC')
        .matchAll(
          /(?<![A-Za-z\p{Script=Greek}\d])\p{Script=Greek}[A-Za-z\d]{2,8}(?![A-Za-z\p{Script=Greek}\d])/gu
        )
    ]
      .map(([value]) => value)
      .filter((value) => /[A-Za-z]/u.test(value) && /\d/u.test(value))
  // A power may be spelled out in Chinese without changing its identity.
  const remaining = identifiers(
    translation
      .normalize('NFKC')
      .replace(
        /(?<![A-Za-z\p{Script=Greek}\d])(\p{Script=Greek})(\d+)\s*的\s*([A-Za-z])\s*次方/gu,
        '$1$3$2'
      )
  )
  return identifiers(source).filter((value) => {
    const index = remaining.indexOf(value)
    if (index < 0) return true
    remaining.splice(index, 1)
    return false
  })
}

// A split formula can make a model copy a numeric token from the next fragment
// into an otherwise number-free prose fragment. Reject that concrete corruption
// during both live admission and checkpoint recovery. Also reject invented
// numeric definitions at split glossary boundaries; other numeric comparisons
// remain the main owner’s responsibility.
export function pdfTranslationAddsNumericLiterals(source: string, translation: string): boolean {
  // A split glossary definition must not acquire an invented numeric value,
  // even when the copied digits also occur elsewhere in the caption.
  const trailingLabel = /[;；]\s*([A-Z]{2,8})\s*$/u.exec(source)?.[1]
  if (
    trailingLabel &&
    new RegExp(`\\b${trailingLabel}\\s*[=＝]\\s*[+−-]?\\d+(?:[.,]\\d+)?[。.]?\\s*$`, 'u').test(
      translation
    )
  )
    return true
  // A caption index is not a spare quantity: "Table 1" cannot also supply
  // "1 kind of seed". Check only explicit Chinese counted quantities;
  // English count words/articles can legitimately become digits, so abstain
  // when those occur rather than guessing their numeric meaning.
  const captionIndex = /^(?:Table|Tab\.|Figure|Fig\.)\s+(\d+)\s*[:.]/iu.exec(source)?.[1]
  if (
    captionIndex &&
    /\p{Script=Han}/u.test(translation) &&
    !/\b(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|single|both|pair|couple|once|twice|first|second|third|each|per)\b/iu.test(
      source
    )
  ) {
    const occurrences = (text: string, countedOnly = false): number => {
      const normalized = text.normalize('NFKC')
      return [
        ...normalized.matchAll(
          /(?<![A-Za-z\p{Script=Greek}\d.,])\d+(?:[.,]\d+)*(?![A-Za-z\p{Script=Greek}\d])/gu
        )
      ].filter(
        (match) =>
          Number(match[0].replace(',', '.')) === Number(captionIndex) &&
          (!countedOnly ||
            /^\s*(?:种|種|组|組|次|个|個|项|項|名|位|例|只|条|條)/u.test(
              normalized.slice(match.index + match[0].length)
            )) &&
          // Naming "this table" explicitly is not a new scientific quantity.
          !/(?:\b(?:Table|Tab\.|Figure|Fig\.)|[图圖表])\s*$/iu.test(
            normalized.slice(0, match.index)
          )
      ).length
    }
    if (occurrences(translation, true) > occurrences(source)) return true
  }
  const sourceNumbers = source.normalize('NFKC').match(/\d+/gu) ?? []
  // A complete convolution-kernel label encodes two ordered dimensions, not
  // a stride identifier supplying a multiplier. Require both exact operands
  // and no additional target number before accepting its spelled-out form.
  const kernel = /^conv([1-9]\d{0,2})[x×]([1-9]\d{0,2})$/iu.exec(source.trim().normalize('NFKC')),
    targetKernel = /^\s*([1-9]\d{0,2})\s*[x×]\s*([1-9]\d{0,2})(?!\d)/u.exec(
      translation.normalize('NFKC')
    ),
    sameKernel =
      kernel &&
      targetKernel &&
      kernel[1] === targetKernel[1] &&
      kernel[2] === targetKernel[2] &&
      !/\d/u.test(translation.normalize('NFKC').slice(targetKernel[0].length))
  // Digits inside a short identifier (e.g. s2) cannot supply an invented
  // leading multiplier. A translated stride is legitimate; an added "2 ×"
  // quantity changes the meaning even though no new digit value appears.
  if (
    source.length <= 80 &&
    sourceNumbers.length > 0 &&
    !sameKernel &&
    !/(?<![A-Za-z\d])\d/u.test(source.normalize('NFKC')) &&
    !/\b(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|single|both|pair|couple|once|twice|each|per)\b/iu.test(
      source
    ) &&
    /^\s*\d+(?:[.,]\d+)?\s*×/u.test(translation.normalize('NFKC'))
  )
    return true
  if (sourceNumbers.length > 0) return false
  const normalized = translation.normalize('NFKC')
  return /\p{Script=Han}/u.test(normalized) && /\d/u.test(normalized)
}

// Compare signs only where the same magnitude occurs equally often on both
// sides. Unit scaling and numeric localization remain the main owner's job.
// Ranges, hyphenated identifiers and binary expressions are not unary signs.
export function pdfTranslationChangesNumericSigns(source: string, translation: string): boolean {
  const signs = (
    text: string
  ): Map<string, { total: number; negative: number; ambiguous: boolean }> => {
    const result = new Map<string, { total: number; negative: number; ambiguous: boolean }>()
    const normalized = text.replace(/⁻(?=[⁰¹²³⁴⁵⁶⁷⁸⁹])/gu, '^−').normalize('NFKC')
    for (const match of normalized.matchAll(/\d+(?:[.,]\d+)?|[.,]\d+/gu)) {
      const key = match[0]
        .replace(',', '.')
        .replace(/^0+(?=\d)/u, '')
        .replace(/^\./u, '0.')
        .replace(/(\.\d*?)0+$/u, '$1')
        .replace(/\.$/u, '')
      const prefix = normalized.slice(0, match.index)
      const minus = /[-−]\s*$/u.exec(prefix)
      const beforeMinus = minus ? prefix.slice(0, minus.index) : ''
      const ambiguous =
        !!minus &&
        (/(?:[\d)\]]\s*|[A-Za-z]|\b[A-Za-z]\s+)$/u.test(beforeMinus) ||
          (/^\s*$/u.test(beforeMinus) && /^-\s/u.test(minus[0])))
      const negative = (!!minus && !ambiguous) || /[负負]\s*$/u.test(prefix)
      const count = result.get(key) ?? { total: 0, negative: 0, ambiguous: false }
      count.total++
      if (negative) count.negative++
      count.ambiguous ||= ambiguous
      result.set(key, count)
    }
    return result
  }
  const translated = signs(translation)
  return [...signs(source)].some(([value, original]) => {
    const target = translated.get(value)
    return (
      target &&
      !original.ambiguous &&
      !target.ambiguous &&
      original.total === target.total &&
      original.negative !== target.negative
    )
  })
}

// Keep citation identities and explicit statistical-header footnotes. Dropping
// a marker prevents the PDF writer from preserving its original linked target.
export function pdfTranslationMissingCitationIdentities(
  source: string,
  translation: string
): string[] {
  const author = "[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ¨¸\\p{M}'’−-]+"
  const citations = [
    ...source.matchAll(
      new RegExp(`[(（]\\s*(${author})\\s+et\\s+al\\.\\s*[,，]\\s*(\\d{4}[a-z]?)\\s*[)）]`, 'gu')
    )
  ]
  const missing = new Set<string>()
  // A marker immediately after a statistical qualifier belongs to the table
  // footnote, not to the prose. Do not infer markers from arbitrary word endings
  // or formulas, where a trailing letter may be part of a name or a variable.
  const tableFootnote =
    source.length <= 100 &&
    /^(?:Mean|Median|Difference|Change|Score|Age)\b/iu.test(source.trim()) &&
    /\((?:\d{1,3}%\s*)?(?:CI|SD|SE)\)([a-z](?:,\s*[a-z])*)\s*$/u.exec(source)
  if (tableFootnote) {
    const expected = tableFootnote[1].replace(/\s/gu, ''),
      actual = /(?:[)）]\s*)([a-z](?:[,，]\s*[a-z])*)\s*[。.]?\s*$/u.exec(translation)
    if (actual?.[1].replace(/[\s，]/gu, (char) => (char === '，' ? ',' : '')) !== expected)
      missing.add(expected)
  }
  const requiredAuthors = new Map<string, number>()
  for (const [, surname] of source.matchAll(
    new RegExp(
      `(?<![A-Za-z])(${author})\\s+et\\s+al\\.(?![A-Za-z]|\\s*[,，]\\s*\\d{4}|\\s*\\[\\d{4})`,
      'gu'
    )
  ))
    requiredAuthors.set(surname, (requiredAuthors.get(surname) ?? 0) + 1)
  for (const [surname, count] of requiredAuthors) {
    const escaped = surname.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const marker = new RegExp(
      `(?<![A-Za-z])${escaped}\\s*(?:et\\s+al\\.|等人?)(?!人)(?![A-Za-z]|\\s*[,，]\\s*\\d{4}|\\s*\\[\\d{4})`,
      'gu'
    )
    if ([...translation.matchAll(marker)].length < count) missing.add(`${surname} et al.`)
  }
  for (const [, surname, year] of citations) {
    const escaped = surname.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const target = new RegExp(
      `[(（]\\s*${escaped}\\s*(?:et\\s+al\\.|等人?)\\s*[,，]\\s*${year}\\s*年?\\s*[)）]`,
      'gu'
    )
    if (!target.test(translation)) missing.add(`${surname} et al., ${year}`)
  }
  return [...missing]
}

// These ordinary scientific labels and clinical section headings are not names,
// even when title-cased. Recognizing them also rejects copied English headings.
// Keep this vocabulary closed: unknown names, acronyms and formula identifiers
// must remain eligible for unchanged output.
function isOrdinaryScientificLabel(source: string): boolean {
  source = source.trim().replace(/^#\s*(params?|parameters)\.?$/i, '$1')
  // Publication labels and clinical table summaries are not proper names.
  if (
    /^(?:open[ -]access|original (?:article|research)|research article|review article|systematic review|case report|brief report|short communication|editorial|letter to the editor|edited by|reviewed by|additional information)$/iu.test(
      source
    ) ||
    /^(?:all grades?|total cycles?|physical symptoms?|(?:sleep|aim trainer) score|AE class|intraoperative HR|limited context|yes|no|unclear|(?:high|low|unclear) risk)$/iu.test(
      source
    )
  )
    return true
  // A treatment cell may stack several ordinary therapy labels. Admit only
  // this complete vocabulary, so organization names and unknown qualifiers
  // cannot borrow the exemption from one treatment word.
  if (
    /^(?:acupuncture|massage|mindfulness|yoga|reflexology)(?:\s+(?:acupuncture|massage|mindfulness|yoga|reflexology)){0,7}$/iu.test(
      source
    )
  )
    return true
  // Task names and training phases are ordinary labels even in diagram title case.
  // Match the whole label; names containing these words still keep their identity.
  if (
    /^(?:question[ -]answer(?:ing)?(?:[ -]pair)?|fine[ -]tuning|language understanding|(?:segment|position|token) embeddings?|token classification|warm[ -]?up steps?|learning rates?(?: decay)?|weight decay|gradient clipping|training time|transformer layers?|(?:dev|development|train(?:ing)?|test|validation) set(?: accuracy| results)?|dev test|single sentence|additional ablation studies|masking rates?|unit types?|no NSP|broader impact|denoising diffusion (?:probabilistic )?models?)$/iu.test(
      source
    )
  )
    return true
  // A metric acronym does not make its summary statistic a proper name.
  if (
    /^(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*,\s*)?(?:[Mm]ean|[Mm]edian)\s*\((?:SD|SE|IQR)\)(?:,\s*(?:mm|cm|mL|kg\/m2|y|°|◦))?$/u.test(
      source
    )
  )
    return true
  if (source.length > 80 || !/^[A-Za-z0-9\s/×–-]+$/u.test(source) || /^log$/i.test(source.trim()))
    return false
  const words = source.match(/[A-Za-z]+/g) ?? []
  const ordinary =
    /^(?:attention|type|multi|single|head|heads|query|queries|caption|image|retrieval|local|global|beam|search|training|model|steps?|scores?|error|rate|average|mean|median|standard|deviation|stddev|inference|stage|exploding|vanishing|gradient|gradients|normalization|batch|index|noise|strengths?|limitations?|and|layer|loss|accuracy|test|validation|log|epoch|conv|convolution|depthwise|separable|pointwise|with|activation|param|params|parameters|covariate|shift|without|physical|therapy|assessment|group|comparison|other|studies|future|research|directions|author|contributions|ethics|approval|clinical|trial|registration|object|detection|finegrain|fine|grained|classification|landmark|recognition|filter|shape|input|size|fully|connected|mult|adds|shallow|train)$/i
  return (
    words.length > 0 &&
    words.length <= 8 &&
    words.some((word) => ordinary.test(word)) &&
    words.every(
      (word) =>
        ordinary.test(word) ||
        /^[A-Z]{2,8}$/u.test(word) ||
        /^[A-Z][a-z]+[A-Z][A-Za-z]*$/u.test(word)
    )
  )
}

// Do not invent captions or conflate named attention variants in short labels.
// Check only an explicit opposite meaning; this is not a general translation score.
export function pdfTranslationConfusesScientificLabel(source: string, text: string): boolean {
  // PDF extraction may attach a footnote marker to its first word ("7We").
  // That number does not authorize the model to turn the note into a caption.
  const footnote = /^\s*(\d{1,3})(?=[A-Z][a-z])/u.exec(source)
  const caption = /^\s*(?:表|图|圖|Table|Figure|Fig\.)\s*(\d{1,3})\s*[:：]/iu.exec(text)
  if (footnote && caption && footnote[1] === caption[1]) return true
  if (!isOrdinaryScientificLabel(source)) return false
  if (/^no NSP$/iu.test(source.trim())) return !/(?<![A-Za-z])NSP(?![A-Za-z])/u.test(text)
  if (/^intraoperative HR$/iu.test(source.trim())) return !/(?<![A-Za-z])HR(?![A-Za-z])/u.test(text)
  if (/\bquer(?:y|ies)\b/i.test(source) && !/\bheads?\b/i.test(source))
    return /多头|多頭|单头|單頭/u.test(text) && !/查询|查詢/u.test(text)
  if (/\bheads?\b/i.test(source) && !/\bquer(?:y|ies)\b/i.test(source))
    return /多查询|多查詢|单查询|單查詢/u.test(text) && !/头|頭/u.test(text)
  return false
}

// Capitalization alone does not make a short declarative paper title a name.
// Require a subject, an explicit finite verb, and an object/complement; author
// bylines and noun-phrase product names remain protected by the rules below.
function isScientificStatementTitle(source: string): boolean {
  const words = source.trim().split(/\s+/u)
  return (
    words.length >= 3 &&
    words.length <= 10 &&
    words.every((word) => /^[A-Z][A-Za-z-]*$/u.test(word)) &&
    words
      .slice(1, -1)
      .some((word) =>
        /^(?:improves?|reduces?|increases?|predicts?|outperforms?|enables?)$/iu.test(word)
      )
  )
}

// Standalone title-cased names are usually organization, product, or project
// names rather than prose. Keep their spelling so native links and document
// identity survive translation (for example, "Hugging Face"). Section labels
// are excluded because they are expected to be translated.
export function pdfTranslationDropsStandaloneProperName(
  source: string,
  translation: string
): boolean {
  const value = source.trim()
  const sectionLabels = new Set([
    'Abstract',
    'Introduction',
    'Conclusion',
    'Conclusions',
    'References',
    'Acknowledgments',
    'Appendix'
  ])
  const methodWords = new Set([
    'algorithm',
    'architecture',
    'benchmark',
    'classifier',
    'dataset',
    'figure',
    'function',
    'language',
    'learning',
    'logistic',
    'method',
    'model',
    'network',
    'optimizer',
    'processing',
    'regression',
    'table',
    'task'
  ])
  // A byline may contain several names with contribution/affiliation markers.
  // Preserve every name token; translating the line can invent author identities.
  const byline = value
    .replace(/[∗*†‡]/gu, '')
    .trim()
    .split(/\s+/u)
  if (
    /[∗*†‡]/u.test(value) &&
    byline.length >= 2 &&
    byline.length <= 16 &&
    byline.every((word) => /^[A-Z][A-Za-z'-]*\.?$/u.test(word)) &&
    !byline.some((word) => methodWords.has(word.toLowerCase()))
  )
    return byline.some((word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return !new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'u').test(translation)
    })
  const words = value.split(/[ -]+/u)
  // The score is translatable, but the named test keeps its original identity.
  if (/^Aim Trainer Score$/iu.test(value))
    return !new RegExp(`(?<![A-Za-z])${value.slice(0, -' Score'.length)}(?![A-Za-z])`, 'u').test(
      translation
    )
  // Small-caps PDF fonts can extract ordinary publication labels as mixed case.
  // A closed lowercase vocabulary proves they are prose before CamelCase is
  // interpreted as a model identifier; unknown names still fail that lookup.
  if (isOrdinaryScientificLabel(value.toLowerCase())) return false
  // Translate ordinary qualifiers beside model identifiers, preserving each
  // identifier. Unknown multi-word names still require their complete spelling.
  const identifiers = words.filter((word) => /^[A-Z][a-z]+[A-Z][A-Za-z]*$/u.test(word))
  if (
    identifiers.length &&
    (identifiers.length === words.length || isOrdinaryScientificLabel(value))
  )
    return identifiers.some(
      (word) => !new RegExp(`(?<![A-Za-z])${word}(?![A-Za-z])`, 'u').test(translation)
    )
  if (
    sectionLabels.has(value) ||
    isScientificStatementTitle(value) ||
    isOrdinaryScientificLabel(value) ||
    value.length > 80 ||
    !/^[A-Z][A-Za-z]+(?:[ -][A-Z][A-Za-z]+){1,3}$/u.test(value) ||
    words.slice(1).some((word) => methodWords.has(word.toLowerCase()))
  )
    return false
  return !translation.includes(value)
}

// Model-generated presentation tags are not document text. Restore only a spelling
// already present in the admitted source, without changing exponent semantics or
// interpreting literal source HTML.
export function normalizePdfTranslationScriptMarkup(source: string, translation: string): string {
  if (/<\/?(?:sub|sup)\b/i.test(source)) return translation
  let result = translation.replace(
    /([A-Za-z\p{Script=Greek}][A-Za-z\p{Script=Greek}\d]*|\d+)<(sub|sup)>([A-Za-z\p{Script=Greek}\d+−→-]{1,12})<\/\2>/gu,
    (literal, prefix: string, kind: string, suffix: string) => {
      if (kind === 'sub' && !/^[A-Za-z\p{Script=Greek}]/u.test(prefix)) return literal
      const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const candidates =
        kind === 'sub'
          ? [`${escaped(prefix)}\\s*${escaped(suffix)}`]
          : [
              `${escaped(prefix)}\\^${escaped(suffix)}`,
              ...(/^\d+$/u.test(suffix)
                ? [
                    escaped(
                      prefix + [...suffix].map((digit) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)]).join('')
                    )
                  ]
                : [])
            ]
      for (const candidate of candidates) {
        const match = new RegExp(
          `(?<![A-Za-z\\p{Script=Greek}\\p{N}])${candidate}(?![A-Za-z\\p{Script=Greek}\\p{N}])`,
          'u'
        ).exec(source)
        if (match) return match[0]
      }
      return literal
    }
  )
  // Unicode subscript letters are absent from the output font. Restore the
  // source-proven identifier spelling; the writer keeps its native lowered glyphs.
  result = result.replace(
    /(?<![A-Za-z\p{Script=Greek}\p{N}])([A-Za-z\p{Script=Greek}][\p{M}]*[⁰¹²³⁴⁵⁶⁷⁸⁹]*)([₀₁₂₃₄₅₆₇₈₉ₐₑₒₓₕₖₗₘₙₚₛₜᵢᵣᵤᵥᵦᵧᵨᵩᵪ]{1,12})(?![A-Za-z\p{Script=Greek}\p{N}])/gu,
    (literal, base: string, suffix: string) => {
      if (source.includes(literal)) return literal
      const identifier = base.normalize('NFKC') + '\\s*' + suffix.normalize('NFKC')
      return new RegExp(
        `(?<![A-Za-z\\p{Script=Greek}\\p{N}])${identifier}(?![A-Za-z\\p{Script=Greek}\\p{N}])`,
        'u'
      ).test(source)
        ? base + suffix.normalize('NFKC')
        : literal
    }
  )
  // A model may restyle the real-number set and its dimension. Restore the
  // admitted source spelling only when that complete identifier is present.
  result = result.replace(
    /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}])ℝ(?:[ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ]|\^[A-Za-z])?(?![\p{Script=Latin}\p{Script=Greek}\p{N}^])/gu,
    (literal) => {
      if (source.includes(literal)) return literal
      const plain = literal.normalize('NFKC').replace('^', '')
      return new RegExp(`(?<![A-Za-z])${plain}(?![A-Za-z])`, 'u').test(source)
        ? literal.normalize('NFKC')
        : literal
    }
  )
  // Remove model-added TeX decoration only for an entire identifier already
  // admitted from the PDF. Literal TeX and different indices remain untouched.
  result = result.replace(
    /(?<![A-Za-z\p{Script=Greek}\d])(?:\$[A-Za-z\p{Script=Greek}][A-Za-z\p{Script=Greek}\d]*\$|[A-Za-z\p{Script=Greek}]_\{[A-Za-z\p{Script=Greek}\d:,]+\})(?![A-Za-z\p{Script=Greek}\d])/gu,
    (literal) => {
      if (source.includes(literal)) return literal
      const plain = literal.replace(/[$_{}]/gu, ''),
        escaped = plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(
        `(?<![A-Za-z\\p{Script=Greek}\\d])${escaped}(?![A-Za-z\\p{Script=Greek}\\d])`,
        'u'
      ).test(source)
        ? plain
        : literal
    }
  )
  // Restore a starred optimum only when that same identifier was extracted.
  // The model may add a TeX caret and even an unmatched math delimiter.
  result = result.replace(
    /(?<![A-Za-z\p{Script=Greek}\d])\$?([A-Za-z\p{Script=Greek}])\^(?:\*|\{\*\})\$?(?![A-Za-z\p{Script=Greek}\d^])/gu,
    (literal, variable: string) => {
      if (source.includes(literal)) return literal
      return (
        new RegExp(
          `(?<![A-Za-z\\p{Script=Greek}\\d])${variable}[*∗](?![A-Za-z\\p{Script=Greek}\\d])`,
          'u'
        ).exec(source)?.[0] ?? literal
      )
    }
  )
  // The common norm/bound spelling is another exact source token, not a
  // general TeX parser. A different index, bound, or relation must stay visible.
  result = result.replace(
    /\$\\\|([A-Za-z\p{Script=Greek}\d:,]+)\\\|_([\d∞]+)\s*\\(leq?|geq?)\s*([A-Za-z\p{Script=Greek}\d∞]+)\$|‖([A-Za-z\p{Script=Greek}\d:,]+)‖_([\d∞]+)/gu,
    (
      literal,
      variable: string,
      index: string,
      relation: string,
      bound: string,
      bareVariable: string,
      bareIndex: string
    ) => {
      if (source.includes(literal)) return literal
      const plain = variable
        ? `‖${variable}‖${index}${relation.startsWith('le') ? '≤' : '≥'}${bound}`
        : `‖${bareVariable}‖${bareIndex}`
      const pattern = [...plain]
        .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s*')
      return (
        new RegExp(`${pattern}(?![A-Za-z\\p{Script=Greek}\\d∞])`, 'u').exec(source)?.[0] ?? literal
      )
    }
  )
  // Undo a model-added TeX wrapper only for the exact scalar comparison
  // already printed in the source. Do not infer or evaluate arbitrary formulas.
  result = result.replace(
    /\\\(\s*([A-Za-z\p{Script=Greek}])\s*\\(geq|leq)\s*(\d+)\s*\\\)/gu,
    (literal, variable: string, relation: string, number: string) => {
      if (source.includes(literal)) return literal
      const symbol = relation === 'geq' ? '≥' : '≤'
      return (
        new RegExp(
          `(?<![A-Za-z\\p{Script=Greek}\\d])${variable}\\s*${symbol}\\s*${number}(?!\\d|\\.\\d)`,
          'u'
        ).exec(source)?.[0] ?? literal
      )
    }
  )
  // Models sometimes return a TeX spelling for a scalar that the PDF extractor
  // gave us as a Unicode variable (for example `$\\beta_2$`). Convert it only
  // when the exact Unicode identifier occurs once in the source and once in the
  // target. This keeps literal TeX and changed indices untouched.
  const greekNames: Record<string, string> = {
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    epsilon: 'ε',
    theta: 'θ',
    lambda: 'λ',
    mu: 'μ',
    pi: 'π',
    sigma: 'σ',
    phi: 'φ',
    omega: 'ω'
  }
  const texGreek =
    /\$?\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|sigma|phi|omega)(?:_\{?([A-Za-z0-9]+)\}?)?\$?/gu
  result = result.replace(texGreek, (literal, name: string, suffix?: string) => {
    const identifier = greekNames[name] + (suffix ?? ''),
      sourcePattern = new RegExp(
        `(?<![A-Za-z\\p{Script=Greek}\\p{N}_])${identifier}(?![A-Za-z\\p{Script=Greek}\\p{N}_])`,
        'gu'
      )
    return [...source.matchAll(sourcePattern)].length === 1 &&
      [...result.matchAll(sourcePattern)].length === 0
      ? identifier
      : literal
  })
  // TeX's unbraced subscript has one character; accented variables can also
  // acquire spacing before that index. Restore only a
  // complete source-proven variable (including its original spacing), never a
  // filename, longer index, changed index, or literal source markup.
  result = result.replace(
    /(?<![A-Za-z\p{Script=Greek}\p{N}_`])([A-Za-z\p{Script=Greek}∆]\u0302?)(?:_|(?<=\u0302)\s*)([A-Za-z\p{Script=Greek}\d])(?![A-Za-z\p{Script=Greek}\p{N}_^`]|\.[A-Za-z])/gu,
    (literal, prefix: string, suffix: string) => {
      if (source.includes(literal)) return literal
      const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      const spellings = new Set(
        [
          ...source.matchAll(
            new RegExp(
              `(?<![A-Za-z\\p{Script=Greek}\\p{N}_])${escape(prefix)}\\s*${escape(suffix)}(?![A-Za-z\\p{Script=Greek}\\p{N}_^])`,
              'gu'
            )
          )
        ].map((match) => match[0])
      )
      return spellings.size === 1 ? [...spellings][0] : literal
    }
  )
  // A model may spell an extracted multi-letter suffix with an underscore.
  // Require the same complete identifier with source spacing inside the suffix;
  // a bare TeX digit sequence, filename, or changed index is not evidence.
  result = result.replace(
    /(?<![A-Za-z\p{N}_`])([A-Za-z])_([a-z]{2,4})(?![A-Za-z\p{N}_^`]|\.[A-Za-z])/gu,
    (literal, prefix: string, suffix: string) => {
      if (source.includes(literal)) return literal
      const spellings = new Set(
        [
          ...source.matchAll(
            new RegExp(
              `(?<![A-Za-z\\p{N}_])${prefix}\\s*${[...suffix].join('\\s*')}(?![A-Za-z\\p{N}_^])`,
              'gu'
            )
          )
        ].map((match) => match[0])
      )
      const spelling = [...spellings][0]
      return spellings.size === 1 && /\s/u.test(spelling.slice(1).trim()) ? spelling : literal
    }
  )
  // A braced subscript is presentation markup only when its complete identifier
  // already exists verbatim in the source. Never interpret literal source TeX.
  return result.replace(
    /([A-Za-z\p{Script=Greek}][A-Za-z\p{Script=Greek}\d]*)_\{([A-Za-z\p{Script=Greek}\d+−→-]{1,12}(?:,[A-Za-z\p{Script=Greek}\d+−→-]{1,12})*)\}/gu,
    (literal, prefix: string, suffix: string) => {
      if (suffix.length > 12 || source.includes(literal)) return literal
      const identifier = prefix + suffix,
        escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      return new RegExp(
        `(?<![A-Za-z\\p{Script=Greek}\\p{N}])${escaped}(?![A-Za-z\\p{Script=Greek}\\p{N}])`,
        'u'
      ).test(source)
        ? identifier
        : literal
    }
  )
}

// Preserve a cited original name alongside its localized spelling. This does not
// declare the names equivalent: the translated text remains untouched, and the
// original citation label is available for exact native link reconstruction.
export function normalizePdfTranslationText(source: string, translation: string): string {
  let result = normalizePdfTranslationScriptMarkup(source, translation)
  // Preserve an unchanged author list when only its comma separators were localized.
  if (
    /^\p{Lu}\./u.test(source) &&
    source.includes(',') &&
    !/\p{Script=Han}/u.test(source) &&
    result.replace(/[、，]/gu, ',').replace(/\s/gu, '') === source.replace(/\s/gu, '')
  )
    result = source
  // Keep an acronym-based identifier's exact spelling when the model inserts
  // a separator before its named component. Do not alter source hyphenated names.
  for (const [identifier, base, component] of source.matchAll(
    /\b([A-Z]{2,5})([A-Z][a-z][A-Za-z]{1,8})\b/gu
  )) {
    if (!source.includes(`${base}-${component}`))
      result = result.replace(
        new RegExp(`(?<![A-Za-z])${base}-${component}(?![A-Za-z])`, 'gu'),
        identifier
      )
  }
  // Format controls are invisible extraction artifacts and are not supported by
  // the bundled output font. Strip them before checkpoint reconciliation so the
  // saved text matches the PDF writer's normalized output.
  result = result.replace(/\p{Cf}/gu, '')
  // A model can wrap an unchanged formula in Markdown emphasis. Restore only
  // an exact source match; literal stars and changed expressions stay intact.
  const emphasis = result.trim().match(/^\*\*([\s\S]+)\*\*$/u)
  if (emphasis && emphasis[1].replace(/\s/gu, '') === source.replace(/\s/gu, '')) result = source
  if (/[<>\p{Cc}]/u.test(source + result)) return result
  // Restore the qualifier of a unique parenthesized supplementary-appendix
  // reference. A shortened label otherwise cannot keep its original PDF link.
  // Multiple or numbered appendices are ambiguous and must remain untouched.
  if (
    /\((?:Suppl\.|Supplementary)\s+Appendix\)/iu.test(source) &&
    (source.match(/\bappendix\b/giu)?.length ?? 0) === 1 &&
    (result.match(/附[录錄]/gu)?.length ?? 0) === 1
  )
    result = result.replace(
      /([（(])附([录錄])([)）])/u,
      (_, open, script, close) => open + (script === '录' ? '补充附录' : '補充附錄') + close
    )
  // A translated short label may redundantly append its complete English
  // source, making it overflow its original cell. Remove only that exact
  // duplicate for known ordinary words; keep names, acronyms and qualifiers.
  const bilingualLabel = /^([\p{Script=Han}\s]+)[（(]([^()（）]+)[）)]$/u.exec(result.trim())
  if (
    bilingualLabel &&
    /^[A-Za-z]+(?:[\s-]+[A-Za-z]+)*$/u.test(source.trim()) &&
    isOrdinaryScientificLabel(source) &&
    source
      .trim()
      .split(/[\s-]+/u)
      .every(isOrdinaryScientificLabel) &&
    bilingualLabel[2].trim() === source.trim()
  )
    result = bilingualLabel[1].trim()
  // The bundled text font lacks superscript minus. Spell the same admitted
  // negative power explicitly; never flatten the exponent or infer a new value.
  const powerPattern =
    /(?<![A-Za-z\p{Script=Greek}\d])\d{1,4}(⁻[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2})(?![A-Za-z\p{Script=Greek}\d⁻⁰¹²³⁴⁵⁶⁷⁸⁹])/gu
  const sourcePowers = [...source.matchAll(powerPattern)],
    targetPowers = [...result.matchAll(powerPattern)]
  result = result.replace(powerPattern, (literal: string, exponent: string) =>
    sourcePowers.filter((match) => match[0] === literal).length ===
    targetPowers.filter((match) => match[0] === literal).length
      ? literal.slice(0, -exponent.length) +
        '^(' +
        exponent.normalize('NFKC').replace('−', '-') +
        ')'
      : literal
  )
  // Restore an admitted prose citation's ASCII spelling. The PDF writer retains
  // the source marker's actual raised geometry; scientific powers and variables
  // must never be flattened by this display repair.
  if ((source.match(/\b[A-Za-z]{2,}\b/gu)?.length ?? 0) >= 6) {
    const markers = [...source.matchAll(/\b[A-Za-z]{4,}(\d{1,3})(?=$|[\s.,;:!?)])/gu)].map(
        (match) => match[1]
      ),
      raised = [...result.matchAll(/\p{Script=Han}([⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3})(?![⁰¹²³⁴⁵⁶⁷⁸⁹])/gu)]
    result = result.replace(
      /(\p{Script=Han})([⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3})(?![⁰¹²³⁴⁵⁶⁷⁸⁹])/gu,
      (literal, prefix: string, marker: string) => {
        const digits = marker.normalize('NFKC')
        return !source.includes(marker) &&
          markers.filter((value) => value === digits).length === 1 &&
          raised.filter((match) => match[1].normalize('NFKC') === digits).length === 1
          ? prefix + digits
          : literal
      }
    )
  }
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  // A caret added after an exact author-year citation is footnote markup.
  // Keep the admitted marker; native PDF geometry supplies its raised position.
  for (const [, author, year, marker] of source.matchAll(
    /\(([A-Z][A-Za-z’'-]+),\s*(\d{4}[a-z]?)\)(\d{1,3})(?!\d)/gu
  )) {
    result = result.replace(
      new RegExp(
        `([（(]${escape(author)}[,，]\\s*${year}[)）])\\^(?:${marker}|\\{${marker}\\})(?![\\d^])`,
        'gu'
      ),
      (_, citation: string) => citation + marker
    )
  }
  const citations = [
    ...source.matchAll(/\(([A-Z][A-Za-z’'-]+(?: [A-Z][A-Za-z’'-]+){1,3}),\s*(\d{4}[a-z]?)\)/gu)
  ]
  for (const [, originalName, year] of citations) {
    const yearPattern = new RegExp(`(?<![A-Za-z\\d])${year}(?![A-Za-z\\d])`, 'gu')
    if (
      [...source.matchAll(yearPattern)].length !== 1 ||
      [...result.matchAll(yearPattern)].length !== 1
    )
      continue
    const originalPattern = new RegExp(`(?<![A-Za-z])${escape(originalName)}(?![A-Za-z])`, 'gu')
    if (originalPattern.test(result)) continue
    const localized = new RegExp(
      `[（(]([\\p{Script=Han}]{2,40})[,，]\\s*${year}\\s*年?[）)]`,
      'u'
    ).exec(result)
    if (!localized) continue
    const count = [...source.matchAll(originalPattern)].length,
      translatedCount = result.split(localized[1]).length - 1
    if (!count || count > 8 || count !== translatedCount) continue
    result = result.replaceAll(localized[1], `${localized[1]}（${originalName}）`)
  }
  // A fully matched citation sequence can identify one localized author without
  // dropping its spelling. Keep the original linked label alongside it; two
  // unknown authors, changed order or changed years do not prove the identity.
  const sourceCitations = [
    ...source.matchAll(/(?<![A-Za-z])([A-Z][A-Za-z’'-]+) et al\.\s*\[(\d{4}[a-z]?)\]/gu)
  ]
  const targetCitations = [
    ...result.matchAll(
      /(?<![A-Za-z\p{Script=Han}])([A-Z][A-Za-z’'-]+|[\p{Script=Han}]{1,4})\s*(?:et al\.|等人)\s*\[(\d{4}[a-z]?)\]/gu
    )
  ]
  if (
    sourceCitations.length >= 2 &&
    sourceCitations.length === targetCitations.length &&
    new Set(sourceCitations.map((match) => match[1])).size === sourceCitations.length &&
    sourceCitations.every((match, index) => match[2] === targetCitations[index][2])
  ) {
    const unmatched = sourceCitations.flatMap((match, index) =>
      match[1] === targetCitations[index][1] ? [] : [index]
    )
    if (unmatched.length === 1) {
      const index = unmatched[0],
        original = sourceCitations[index],
        localized = targetCitations[index]
      if (
        /^[\p{Script=Han}]{1,4}$/u.test(localized[1]) &&
        !new RegExp(`(?<![A-Za-z])${escape(original[1])}(?![A-Za-z])`, 'u').test(result)
      ) {
        const insertion = localized.index! + localized[0].indexOf('[')
        result = result.slice(0, insertion) + `（${original[1]} et al.）` + result.slice(insertion)
      }
    }
  }
  return result
}

// Reject copied English prose and known ordinary scientific labels for Chinese targets.
// Names, equations and unknown labels remain valid unchanged document content.
export function pdfTranslationCopiesEnglishProse(
  source: string,
  text: string,
  language: string
): boolean {
  if (
    !/^(Chinese|中文|简体中文|簡體中文|繁体中文|繁體中文|zh(?:[-_][a-z]+)*)$/i.test(
      language.trim()
    ) ||
    /\p{Script=Han}/u.test(source)
  )
    return false
  const prose = source.replace(/https?:\/\/\S+|\S+@\S+/g, ''),
    words = prose.match(/\b[a-z]{2,}\b/g)?.length ?? 0,
    captionPrefix = /^(?:Figure|Fig\.|Table|Tab\.|图|圖|表)\s*\d+[a-z]?\s*[.:：、-]?\s*/iu,
    caption = captionPrefix.test(prose) && words >= 4,
    measureDescription =
      /\b(?:Questionnaire|Subscale|Index|Score)\b/iu.test(prose) &&
      /\b(?:of|for)\b/iu.test(prose) &&
      (prose.match(/\b[A-Za-z]{2,}\b/gu)?.length ?? 0) >= 6,
    sentence =
      isScientificStatementTitle(source) ||
      (/\b(?:is|are|was|were|has|have|had|the|this)\b/i.test(prose) && words >= 4),
    instruction =
      /^(?:\d+[:.)]\s*)?(?:Add|Apply|Compute|Initialize|Update|Calculate|Normalize|Modify|Estimate|Return|Repeat|Remove)\s/i.test(
        prose.trim()
      ) && words >= 2
  const label = isOrdinaryScientificLabel(source)
  if (!sentence && !instruction && !label && !caption && !measureDescription) return false
  if (label && /\p{Script=Han}/u.test(text)) {
    // Bilingual labels may retain the original in parentheses; ordinary label
    // words outside them still need translation (for example, "Beam-4 搜索").
    const translatedLabel = text.replace(/[(（](?:[^()（）]|[(（][^()（）]*[)）])*[)）]/gu, '')
    return (source.match(/[A-Za-z]+/g) ?? [])
      .filter(isOrdinaryScientificLabel)
      .some((word) => new RegExp(`(?<![A-Za-z])${word}(?![A-Za-z])`, 'i').test(translatedLabel))
  }
  const comparable = (value: string): string =>
    normalizePdfTranslationText(source, value)
      .replace(
        /(\d+(?:\.\d+)?\s*[×·]\s*10)([⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2})(?!\p{N})/gu,
        (_, base: string, raised: string) => base + '^' + raised.normalize('NFKC')
      )
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      // Translating only “Figure 3” must not admit an otherwise copied caption.
      .replace(captionPrefix, '')
      .toLowerCase()
  const original = comparable(source),
    translated = comparable(text)
  if (original === translated) return true
  // A translated heading must not hide whole copied body sentences. Require
  // a long source-matching clause with a verb, leaving names and technical
  // labels alone even when they contain many English words.
  // Recognized English prose still needs Chinese text when the model merely
  // repairs line hyphens, edits punctuation or paraphrases the source.
  if (!/\p{Script=Han}/u.test(text)) return true
  return (
    text
      .replace(/https?:\/\/\S+|\S+@\S+/g, '')
      .match(/[A-Za-z][A-Za-z0-9\s,;:'’"“”()[\]–—−%-]*/g) ?? []
  ).some(
    (clause) =>
      (clause.match(/\b[a-z]{2,}\b/g)?.length ?? 0) >= 8 &&
      /\b(?:is|are|was|were|has|have|had|should|must|can|could|will|would|included|showed|measured|reported|found)\b/i.test(
        clause
      ) &&
      /\b(?:the|this|these|those|we|our|their|in|with|from|of|for)\b/i.test(clause) &&
      original.includes(comparable(clause))
  )
}

export function pdfTranslationSourceIndices(checkpoint: PdfTranslationCheckpoint): number[] {
  return checkpoint.translatedSourceIndices
}

export function nextPdfTranslationSourceIndex(checkpoint: PdfTranslationCheckpoint): number {
  const pending = new Set(
    checkpoint.failures
      ?.filter(isPdfTranslationFailureRetryable)
      .map((failure) => failure.sourceIndex)
  )
  const indices = [
    ...pdfTranslationSourceIndices(checkpoint),
    ...(checkpoint.failedSourceIndices ?? []).filter((index) => !pending.has(index))
  ].sort((a, b) => a - b)
  const gap = indices.findIndex((sourceIndex, position) => sourceIndex !== position)
  return gap < 0 ? indices.length : gap
}

// Some PDF extractors move a trailing clearance/citation number into a
// source-only unit on a later pass. Reuse the preceding saved paragraph only
// for a unique exact prefix whose detached suffix is purely numeric; ordinary
// prose truncation and paragraph splits remain ineligible.
function detachedNumericSuffix(saved: string, current: string): string | undefined {
  if (!saved.startsWith(current) || saved.length === current.length) return undefined
  // A paragraph ending in an ordinary number is still a prose change. The
  // extractor case this protects is metadata such as "clearance number 2010…";
  // require that cue before accepting the detached source-only value.
  if (
    !/(?:approval|clearance|citation|reference|ref\.?|identifier|number|no\.?|code|\bid)\s*$/iu.test(
      current.trimEnd()
    )
  )
    return undefined
  const suffix = saved.slice(current.length)
  return /^\s+\d[\d./–−-]*\.?\s*$/u.test(suffix) ? suffix : undefined
}

function trimDetachedNumericTranslation(translation: string, suffix: string): string {
  const numeric = suffix.trim().replace(/[.。]\s*$/u, '')
  if (!numeric) return translation
  const escaped = numeric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = translation.match(new RegExp(`\\s*${escaped}[.。]?\\s*$`, 'u'))
  return match?.index === undefined ? translation : translation.slice(0, match.index).trimEnd()
}

// File checksum and attachment identity are verified by the storage owner before this runs.
// Reuse proven ordered or unique, byte-for-byte source matches; never guess
// how to split or merge a translation.
export function reconcilePdfTranslationCheckpoint(
  checkpoint: PdfTranslationCheckpoint,
  fingerprint: string,
  sources: readonly string[]
): PdfTranslationCheckpoint | undefined {
  if (checkpoint.fingerprint !== fingerprint) return undefined
  if (
    checkpoint.layoutSnapshot &&
    (sources.length !== checkpoint.sources.length ||
      sources.some((source, index) => source !== checkpoint.sources[index]))
  )
    return undefined
  // Failed indices are meaningful only for the exact extraction that produced them.
  if (
    (checkpoint.failedSourceIndices?.length || checkpoint.layoutReports?.length) &&
    (sources.length !== checkpoint.sources.length ||
      sources.some((text, index) => text !== checkpoint.sources[index]))
  )
    checkpoint = {
      ...checkpoint,
      failedSourceIndices: undefined,
      failures: undefined,
      layoutReports: undefined
    }
  const sourceIndicesBefore = pdfTranslationSourceIndices(checkpoint)
  const currentCounts = new Map<string, number>()
  for (const source of sources) currentCounts.set(source, (currentCounts.get(source) ?? 0) + 1)
  const detached = new Map<number, { current: string; suffix: string }>()
  for (let newIndex = 0; newIndex < sources.length; newIndex++) {
    const current = sources[newIndex]
    if (currentCounts.get(current) !== 1) continue
    const candidates = checkpoint.sources.flatMap((saved, oldIndex) => {
      const suffix = detachedNumericSuffix(saved, current)
      return suffix === undefined ? [] : [{ oldIndex, suffix }]
    })
    if (candidates.length === 1)
      detached.set(candidates[0].oldIndex, { current, suffix: candidates[0].suffix })
  }
  if (detached.size) {
    checkpoint = {
      ...checkpoint,
      sources: checkpoint.sources.map(
        (saved, oldIndex) => detached.get(oldIndex)?.current ?? saved
      ),
      translations: checkpoint.translations.map((translation, position) => {
        const oldIndex = sourceIndicesBefore[position],
          change = detached.get(oldIndex)
        return change ? trimDetachedNumericTranslation(translation, change.suffix) : translation
      })
    }
  }
  const sourceIndices = pdfTranslationSourceIndices(checkpoint)
  const translations = checkpoint.translations.map((translation, index) =>
    normalizePdfTranslationText(checkpoint.sources[sourceIndices[index]], translation)
  )
  if (translations.some((translation, index) => translation !== checkpoint.translations[index]))
    checkpoint = { ...checkpoint, translations, layoutReports: undefined }
  // Table extraction can split names that were deliberately kept verbatim.
  // Only split a unique saved identity result into one exact current sequence;
  // never infer how a real translation corresponds to its source fragments.
  const savedPositions = pdfTranslationSourceIndices(checkpoint)
  const splits = new Map<number, string[]>()
  for (const [position, translation] of checkpoint.translations.entries()) {
    const oldIndex = savedPositions[position],
      text = checkpoint.sources[oldIndex]
    if (
      translation !== text ||
      currentCounts.has(text) ||
      checkpoint.sources.indexOf(text) !== checkpoint.sources.lastIndexOf(text)
    )
      continue
    const candidates: string[][] = []
    for (let start = 0; start < sources.length; start++) {
      if (!sources[start] || !text.startsWith(sources[start] + ' ')) continue
      let joined = sources[start]
      for (let end = start + 1; end < sources.length; end++) {
        joined += ' ' + sources[end]
        if (!text.startsWith(joined)) break
        if (joined === text) {
          candidates.push(sources.slice(start, end + 1))
          break
        }
      }
    }
    if (candidates.length === 1) splits.set(oldIndex, candidates[0])
  }
  if (splits.size) {
    const expandedSources: string[] = [],
      expandedTranslations: string[] = [],
      expandedIndices: number[] = [],
      saved = new Map(
        savedPositions.map((index, position) => [index, checkpoint.translations[position]])
      )
    checkpoint.sources.forEach((text, index) => {
      for (const source of splits.get(index) ?? [text]) {
        if (saved.has(index)) {
          expandedIndices.push(expandedSources.length)
          expandedTranslations.push(splits.has(index) ? source : saved.get(index)!)
        }
        expandedSources.push(source)
      }
    })
    // Reapply the normal per-unit validation, including untranslated-label checks.
    // Every expanded fragment already exists in currentCounts, so it cannot split again.
    return reconcilePdfTranslationCheckpoint(
      {
        ...checkpoint,
        version: 1,
        sources: expandedSources,
        translations: expandedTranslations,
        translatedSourceIndices: expandedIndices
      },
      fingerprint,
      sources
    )
  }
  const accepted = translations.flatMap((translation, position) =>
    pdfTranslationConfusesScientificLabel(
      checkpoint.sources[sourceIndices[position]],
      translation
    ) ||
    pdfTranslationHasCommentary(checkpoint.sources[sourceIndices[position]], translation) ||
    pdfTranslationIntroducesMathMarkup(checkpoint.sources[sourceIndices[position]], translation) ||
    pdfTranslationAddsNumericLiterals(checkpoint.sources[sourceIndices[position]], translation) ||
    pdfTranslationChangesNumericSigns(checkpoint.sources[sourceIndices[position]], translation) ||
    pdfTranslationMissingNumericUnits(checkpoint.sources[sourceIndices[position]], translation)
      .length > 0 ||
    pdfTranslationMissingCitationIdentities(
      checkpoint.sources[sourceIndices[position]],
      translation
    ).length > 0 ||
    pdfTranslationDropsStandaloneProperName(
      checkpoint.sources[sourceIndices[position]],
      translation
    ) ||
    pdfTranslationReordersInlineMath(checkpoint.sources[sourceIndices[position]], translation) ||
    pdfTranslationMissingMathIdentifiers(checkpoint.sources[sourceIndices[position]], translation)
      .length > 0 ||
    pdfTranslationCopiesNeighborFormula(
      checkpoint.sources[sourceIndices[position]],
      translation,
      checkpoint.sources.slice(
        Math.max(0, sourceIndices[position] - 2),
        sourceIndices[position] + 3
      )
    ) ||
    pdfTranslationCopiesEnglishProse(
      checkpoint.sources[sourceIndices[position]],
      translation,
      checkpoint.language
    )
      ? []
      : [{ translation, sourceIndex: sourceIndices[position] }]
  )
  if (accepted.length !== translations.length)
    checkpoint = {
      ...checkpoint,
      version: 1,
      layoutReports: undefined,
      translations: accepted.map(({ translation }) => translation),
      translatedSourceIndices: accepted.map(({ sourceIndex }) => sourceIndex)
    }
  else if (
    translations.some((translation, index) => translation !== checkpoint.translations[index])
  )
    checkpoint = { ...checkpoint, translations, layoutReports: undefined }
  if (
    sources.length === checkpoint.sources.length &&
    sources.every((text, index) => text === checkpoint.sources[index])
  )
    return checkpoint
  // Excluding a trailing bibliography does not change the preceding paragraphs,
  // including repeated table labels. Keep their existing positional identities.
  if (
    sources.length > 0 &&
    sources.length < checkpoint.sources.length &&
    sources.every((text, index) => text === checkpoint.sources[index])
  ) {
    const indices = pdfTranslationSourceIndices(checkpoint)
    return {
      ...checkpoint,
      version: 1,
      sources: [...sources],
      translations: checkpoint.translations.filter((_, index) => indices[index] < sources.length),
      translatedSourceIndices: indices.filter((index) => index < sources.length)
    }
  }
  // Reclassifying standalone formulas removes entries without changing their order.
  // Match the surviving prefix from both ends: only equal positions prove which
  // repeated table label was retained. A new appendix may follow that prefix.
  const forward: number[] = []
  let cursor = 0
  for (const text of sources) {
    const index = checkpoint.sources.indexOf(text, cursor)
    if (index < 0) break
    forward.push(index)
    cursor = index + 1
  }
  const unmatched = new Set(sources.slice(forward.length))
  const ordered = new Map<number, number>()
  cursor = checkpoint.sources.length - 1
  for (let index = forward.length - 1; index >= 0; index--) {
    cursor = checkpoint.sources.lastIndexOf(sources[index], cursor)
    if (cursor === forward[index] && !unmatched.has(sources[index])) ordered.set(cursor, index)
    cursor--
  }
  const unique = (values: readonly string[]): Map<string, number> => {
    const result = new Map<string, number>()
    values.forEach((text, index) => result.set(text, result.has(text) ? -1 : index))
    return result
  }
  const oldIndices = unique(checkpoint.sources)
  const newIndices = unique(sources)
  const oldCounts = new Map<string, number>()
  for (const source of checkpoint.sources) oldCounts.set(source, (oldCounts.get(source) ?? 0) + 1)
  // An extraction change can invalidate the prefix without changing later table
  // labels. Between unchanged unique anchors, both directions must identify
  // the same old position. This tolerates removed formulas without guessing
  // which repeated label survived, or reusing newly inserted text.
  const anchors = sources.flatMap((text, index) => {
    const oldIndex = oldIndices.get(text)
    return oldIndex !== undefined && oldIndex >= 0 && newIndices.get(text) === index
      ? [{ oldIndex, newIndex: index }]
      : []
  })
  const boundaries = [
    { oldIndex: -1, newIndex: -1 },
    ...anchors,
    { oldIndex: checkpoint.sources.length, newIndex: sources.length }
  ]
  // A local reorder must not invalidate unrelated repeated labels elsewhere.
  // Only adjacent anchors in BOTH orders delimit an unambiguous interval.
  const oldOrder = new Map(
    boundaries
      .toSorted((a, b) => a.oldIndex - b.oldIndex)
      .map((anchor, index) => [anchor.oldIndex, index])
  )
  for (let index = 1; index < boundaries.length; index++) {
    const left = boundaries[index - 1],
      right = boundaries[index]
    if (oldOrder.get(right.oldIndex)! !== oldOrder.get(left.oldIndex)! + 1) continue
    const previous = checkpoint.sources.slice(left.oldIndex + 1, right.oldIndex),
      current = sources.slice(left.newIndex + 1, right.newIndex),
      positions: number[] = []
    let cursor = 0
    for (const text of current) {
      const position = previous.indexOf(text, cursor)
      if (position < 0) break
      positions.push(position)
      cursor = position + 1
    }
    if (positions.length !== current.length) continue
    // Removing numeric-only cells must not invalidate stable labels just because
    // another table now exposes an extra copy. Removed prose remains ambiguous.
    const retainedPositions = new Set(positions)
    const removedOnlyNumeric = previous.every(
      (text, index) => retainedPositions.has(index) || /^[\d\s.,%+−–—()-]+$/u.test(text)
    )
    cursor = previous.length - 1
    for (let offset = current.length - 1; offset >= 0; offset--) {
      const position = previous.lastIndexOf(current[offset], cursor)
      if (
        position === positions[offset] &&
        (previous.length === current.length ||
          oldCounts.get(current[offset]) === currentCounts.get(current[offset]) ||
          removedOnlyNumeric)
      )
        ordered.set(left.oldIndex + position + 1, left.newIndex + offset + 1)
      cursor = position - 1
    }
  }
  const savedIndices = pdfTranslationSourceIndices(checkpoint)
  const matches = checkpoint.translations.flatMap((translation, position) => {
    const oldIndex = savedIndices[position]
    const text = checkpoint.sources[oldIndex]
    const newIndex = ordered.get(oldIndex) ?? newIndices.get(text)
    return (ordered.has(oldIndex) || oldIndices.get(text) === oldIndex) &&
      newIndex !== undefined &&
      newIndex >= 0
      ? [{ index: newIndex, translation }]
      : []
  })
  // Repeated technical identifiers have no positional ambiguity when every
  // saved occurrence passed validation and was kept exactly unchanged. Require
  // equal occurrence counts; never fill new labels or incomplete/conflicting results.
  const identities = new Map<string, number>()
  for (const [position, translation] of checkpoint.translations.entries()) {
    const text = checkpoint.sources[savedIndices[position]]
    if (
      translation === text &&
      /^[A-Za-z][A-Za-z0-9]*$/u.test(text) &&
      /[a-z][A-Z]|[A-Za-z]\d/u.test(text)
    )
      identities.set(text, (identities.get(text) ?? 0) + 1)
  }
  const matched = new Set(matches.map(({ index }) => index))
  sources.forEach((text, index) => {
    const count = identities.get(text) ?? 0
    if (
      !matched.has(index) &&
      count > 1 &&
      count === oldCounts.get(text) &&
      count === currentCounts.get(text)
    )
      matches.push({ index, translation: text })
  })
  matches.sort((a, b) => a.index - b.index)
  if (!matches.length) return undefined
  return {
    ...checkpoint,
    version: 1,
    sources: [...sources],
    translations: matches.map(({ translation }) => translation),
    translatedSourceIndices: matches.map(({ index }) => index)
  }
}
