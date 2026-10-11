/* eslint-disable @typescript-eslint/explicit-function-return-type -- Shared worker/renderer JavaScript. */
// Canonical scientific identities and exact whole-paragraph link ownership.
// No approximate matching: changing the referenced number is never equivalent.
const labels =
  /(?:\b(?:Table|Tab\.?|Figure|Fig\.?|Theorem)\s*\d+\b|(?:[表图圖]|定理)\s*\d+|\b(?:online\s+supplemental\s+file)\s+\d+\b(?![.．]\s*[A-Za-z\d])|(?:在线补充文件|在線補充文件|線上補充檔案)\s*\d+(?![.．]\s*[A-Za-z\d])|\b(?:Supplementary|Suppl\.)\s+Table\s*\d+\b|补充表\s*\d+|補充表\s*\d+|\bS\d+\s*(?:File\b|文件|檔案|Fig\.?(?![A-Za-z.])|Figure\b|图|圖|Table\b|表)|\b(?:Suppl\.|Supplementary)\s*Appendix\b|补充附录|附录补充|補充附錄|附錄補充|[“”"][。.!?]?\s*\d+)(?![A-Za-z\d]|[.．,，–—−-]\s*\d)/giu
// Section references require their complete hierarchical number; bare numbers,
// descendants and ranges are not interchangeable link identities.
const sections =
  /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_])(?:Section\s+|Sec\.?\s*|§\s*)(?:\d+|[A-Za-z][.．]\d+)(?:[.．]\d+)*(?![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_]|[.．,，–—−-]\s*\d)|第\s*(?:\d+|[A-Za-z][.．]\d+)(?:[.．]\d+)*\s*[节節](?![\p{N}\p{M}_]|\s*(?:[–—−-]|至)\s*第?(?:\d|[A-Za-z][.．]\d))/giu
function* sectionMatches(text) {
  for (const match of text.matchAll(sections)) {
    const before = text.slice(0, match.index),
      after = text.slice(match.index + match[0].length)
    if (
      /(?:\d|[节節])\s*(?:[–—−,，/-]|至)\s*$/u.test(before) ||
      /^\s*(?:[–—−,，/-]|至)\s*(?:(?:Section\s+|Sec\.?\s*|§\s*)|第\s*)?(?:\d|[A-Za-z][.．]\d)/iu.test(
        after
      ) ||
      /^[.．][\p{L}\p{N}\p{M}_]/u.test(after) ||
      /[\u{1d400}-\u{1d7ff}]$/u.test(before) ||
      /^[\u{1d400}-\u{1d7ff}]/u.test(after)
    )
      continue
    yield match
  }
}
// Appendix letters are distinct from section numbers and remain case-sensitive.
function* appendixMatches(text) {
  for (const match of text.matchAll(
    /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_])(?:Appendix\s+|附[录錄]\s*)[A-Za-z](?![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_])/giu
  )) {
    if (!/[A-Za-z]$/u.test(match[0])) continue
    const before = text.slice(0, match.index),
      after = text.slice(match.index + match[0].length)
    if (
      /(?:\bSupplementary\s+|\bSuppl\.\s*|补充\s*|補充\s*)$/iu.test(before) ||
      /(?:\b(?:Appendix\s+)?[A-Za-z]|附[录錄]\s*[A-Za-z])\s*(?:[–—−,，/-]|至|\bto\b)\s*$/iu.test(
        before
      ) ||
      /^\s*(?:[–—−,，/-]|至|\bto\b)\s*(?:Appendix\s+|附[录錄]\s*)?[A-Za-z](?![A-Za-z])/iu.test(
        after
      ) ||
      /^\s*[.．]\s*\d/u.test(after) ||
      /^[.．(（][\p{L}\p{N}\p{M}_]/u.test(after) ||
      /[\u{1d400}-\u{1d7ff}]$/u.test(before) ||
      /^[\u{1d400}-\u{1d7ff}′″‴']/u.test(after)
    )
      continue
    yield match
  }
}
const supportingInformation = /\bSupporting\s+information\b|支持(?:信息|資訊|材料)/giu
// Author identities stay literal. Only the conjunction / collective-author marker
// is localized; organization names and transliterated surnames are not inferred.
const author = "[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ¨¸`\\p{M}'’−-]+"
const authorName = `${author}(?:\\s+${author}){0,3}`
const citation = new RegExp(
  `(?<![A-Za-zÀ-ÖØ-öø-ÿ])(?:${author}\\s*(?:et\\s*al\\.|等人?|&\\s*${author}|\\band\\s+${author}|[和与與]\\s*${author})|(?:&|\\band\\s+)\\s*${author})(?![A-Za-zÀ-ÖØ-öø-ÿ])`,
  'gu'
)
// Prose conjunctions can overlap a following citation ("and Quinn et al.").
// Keep every candidate start; the complete canonical identity still selects it.
function* citationMatches(text) {
  const matcher = new RegExp(citation)
  let match
  while ((match = matcher.exec(text))) {
    yield match
    matcher.lastIndex = match.index + 1
  }
}
const compoundAuthor = `${author}\\s+${author}(?:\\s+${author}){0,2}`
const compoundCitation = new RegExp(
  `(?<=[(（]\\s*)(?:${compoundAuthor}\\s*(?:&|and\\s+|[和与與])\\s*${authorName}|${author}\\s*(?:&|and\\s+|[和与與])\\s*${compoundAuthor})(?![A-Za-zÀ-ÖØ-öø-ÿ])`,
  'gu'
)
// Whole dated links keep their author and year together, even when the
// collective marker and comma are localized. A changed year is another citation.
const datedCitation = new RegExp(
  `(?<![A-Za-zÀ-ÖØ-öø-ÿ])${author}\\s*(?:et\\s*al\\.|等人?|(?:&|[和与與])\\s*${author}|\\band\\s+${author})?\\s*[,，(（]\\s*\\d{4}[a-z]?\\s*年?(?![A-Za-z\\d])`,
  'gu'
)
export function pdfLinkAddressMatches(text) {
  return [
    ...text.matchAll(
      /\b(?:https?:\/\/|www\.)(?:[A-Za-z\d._~:/?#@!$&'*+,;=%-]|(?<=[./?#&=-]) +(?=[A-Za-z\d]))+/gu
    )
  ]
    .map((match) => ({ text: match[0].replace(/[.,;:]+$/u, ''), index: match.index }))
    .filter((match) => {
      try {
        const address = match.text.replace(/ /gu, '')
        const url = new URL(address.startsWith('www.') ? 'https://' + address : address)
        return url.hostname.includes('.') && !url.hostname.endsWith('.')
      } catch {
        return false
      }
    })
}
export function pdfLinkLabelMatches(text, label) {
  const key = pdfLinkLabelKey(label)
  if (!key) return []
  const suffixAuthor = key.startsWith('authors:&') ? key.slice('authors:&'.length) : null
  const matcher = suffixAuthor
    ? new RegExp(
        `(?:&|\\band\\s+|[和与與])\\s*${suffixAuthor.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![A-Za-zÀ-ÖØ-öø-ÿ])`,
        'gu'
      )
    : citation
  return [
    ...text.matchAll(labels),
    ...sectionMatches(text),
    ...appendixMatches(text),
    ...text.matchAll(supportingInformation),
    ...text.matchAll(datedCitation),
    ...text.matchAll(compoundCitation),
    ...(suffixAuthor ? text.matchAll(matcher) : citationMatches(text)),
    ...text.matchAll(/(?<![A-Za-z\d.])\d+\s*[（(][A-Za-z][)）](?![A-Za-z\d])/gu)
  ]
    .filter((match) => pdfLinkLabelKey(match[0]) === key)
    .sort((a, b) => a.index - b.index)
}
export function pdfLinkLabelKey(text) {
  const normalized = text.normalize('NFKC').replace(/\s/gu, '')
  const section = normalized.match(
    /^(?:(?:Section|Sec\.?|§)((?:\d+|[A-Za-z]\.\d+)(?:\.\d+)*)|第((?:\d+|[A-Za-z]\.\d+)(?:\.\d+)*)[节節])$/iu
  )
  if (section) return 'section:' + (section[1] ?? section[2])
  const appendix = text.replace(/\s/gu, '').match(/^(?:Appendix|附[录錄])([A-Za-z])$/iu)
  if (appendix && /^[A-Za-z]$/u.test(appendix[1])) return 'appendix:' + appendix[1]
  const panel = normalized.match(/^(\d+)\(([A-Za-z])\)$/u)
  if (panel) return `panel:${panel[1]}:${panel[2]}`
  const value = normalized.toLowerCase()
  if (/^(?:supportinginformation|支持(?:信息|資訊|材料))$/u.test(value))
    return 'supporting-information'
  const onlineFile = value.match(
    /^(?:onlinesupplementalfile|在线补充文件|在線補充文件|線上補充檔案)(\d+)$/u
  )
  if (onlineFile) return 'online-supplemental-file:' + onlineFile[1]
  const supplementaryFile = value.match(/^s(\d+)(?:file|文件|檔案)$/u)
  if (supplementaryFile) return 'supplementary-file:' + supplementaryFile[1]
  const supplementaryFigure = value.match(/^s(\d+)(?:fig\.?|figure|图|圖)$/u)
  if (supplementaryFigure) return 'supplementary-figure:' + supplementaryFigure[1]
  const supplementaryTable = value.match(
    /^(?:s(\d+)(?:table|表)|(?:supplementarytable|suppl\.table|补充表|補充表)(\d+))$/u
  )
  if (supplementaryTable)
    return 'supplementary-table:' + (supplementaryTable[1] ?? supplementaryTable[2])
  if (/^[“”"][。.!?]?\s*\d+$/u.test(value)) return 'quoted-citation:' + value.match(/\d+$/u)[0]
  if (/^(?:table|tab\.?|表)\d+$/u.test(value)) return 'table:' + value.match(/\d+$/u)[0]
  if (/^(?:figure|fig\.?|图|圖)\d+$/u.test(value)) return 'figure:' + value.match(/\d+$/u)[0]
  if (/^(?:theorem|定理)\d+$/u.test(value)) return 'theorem:' + value.match(/\d+$/u)[0]
  if (/^(?:(?:suppl\.|supplementary)appendix|补充附录|附录补充|補充附錄|附錄補充)$/u.test(value))
    return 'supplementary-appendix'
  // PDF fonts can extract a spacing accent before its letter, or a cedilla
  // after it. Compose those accents rather than dropping them from the identity.
  const citationValue = text
    .replace(/\s+and\s+/gu, '&')
    .replace(/¨([A-Za-z])/gu, '$1\u0308')
    .replace(/([A-Za-z])`([AEIOUaeiou])/gu, '$1$2\u0300')
    .replace(/([A-Za-z])¸/gu, '$1\u0327')
    .normalize('NFKC')
    .replace(/\s/gu, '')
    .replace(/[,，]$/u, '')
  const dated = citationValue.match(/^(.+)[,，(（](\d{4}[a-z]?)年?$/u)
  if (dated) {
    const authors = pdfLinkLabelKey(dated[1])
    if (authors?.startsWith('authors:')) return `dated-${authors}:${dated[2]}`
    if (new RegExp(`^${author}$`, 'u').test(dated[1])) return `dated-author:${dated[1]}:${dated[2]}`
  }
  const collective = citationValue.match(new RegExp(`^(${author})(?:etal\\.|等人?)$`, 'u'))
  if (collective) return 'authors:' + collective[1] + ':et-al'
  const pair = citationValue.match(
    new RegExp(`^(${author})?(?:&|and(?=[A-ZÀ-ÖØ-Þ])|[和与與])(${author})$`, 'u')
  )
  if (pair) return 'authors:' + (pair[1] ?? '') + '&' + pair[2]
  return null
}
// A literal organization name can occur in prose and once in a dated citation.
// Match the dated citation itself; unlinked prose may legitimately be translated.
function datedLiteralCitation(source, translation, label, offset) {
  if (
    !new RegExp(`^${author}(?: ${author}){0,3}$`, 'u').test(label) ||
    source.slice(offset, offset + label.length) !== label ||
    !/[(（]\s*$/u.test(source.slice(0, offset))
  )
    return null
  const year = source.slice(offset + label.length).match(/^[,，]\s*(\d{4}[a-z]?)\s*[)）]/u)?.[1]
  if (!year) return null
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
    pattern = new RegExp(`[(（]\\s*(${escaped})[,，]\\s*${year}\\s*年?[)）]`, 'gu'),
    from = [...source.matchAll(pattern)],
    to = [...translation.matchAll(pattern)]
  if (from.length !== 1 || to.length !== 1) return null
  return { start: to[0].index + to[0][0].indexOf(to[0][1]), text: to[0][1] }
}
// Extraction can split a citation after its author name. Admit only the complete
// dated tail, with the same year/suffix; a bare collective marker proves nothing.
// Keep this symmetric so the renderer can verify the exported link in reverse.
function datedCollectiveTail(source, translation, label, offset) {
  const pattern = /^(et\s*al\.|等人?)([,，])\s*(\d{4}[a-z]?)\s*年?[)）]$/u,
    from = source.match(pattern),
    to = translation.match(pattern)
  if (!from || !to || from[3] !== to[3] || offset !== 0) return null
  if (label === from[1]) return { start: 0, text: to[1] }
  if (label === from[1] + from[2]) return { start: 0, text: to[1] + to[2] }
  return null
}
// A linked footnote can be rendered with Unicode superscript digits. Require
// one complete numeric occurrence on each side, never a substring of a year,
// decimal, indexed identifier, or a repeated number with uncertain ownership.
function superscriptFootnote(source, translation, label, offset) {
  if (!/^(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3})$/u.test(label)) return null
  const key = label.normalize('NFKC')
  const matches = (text) =>
    [
      ...text.matchAll(/(?<![A-Za-z\p{N}⁺⁻⁼⁽⁾])(?:\d+|[⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?![A-Za-z\p{N}]|[.,]\d)/gu)
    ].filter(
      (match) =>
        match[0].normalize('NFKC') === key &&
        (text[match.index - 1] !== '.' ||
          /[A-Za-z]{3,}\.$/u.test(text.slice(0, match.index)) ||
          // A closed dated citation can end the sentence before a footnote.
          // A parenthesized number or an unfinished citation is not that proof.
          [...text.slice(0, match.index).matchAll(datedCitation)].some((citation) =>
            /^\s*[)）]\.$/u.test(text.slice(citation.index + citation[0].length, match.index))
          ))
    )
  const from = matches(source),
    to = matches(translation)
  return from.length === 1 &&
    to.length === 1 &&
    from[0].index === offset &&
    from[0][0] === label &&
    to[0][0] !== label
    ? { start: to[0].index, text: to[0][0] }
    : null
}

// Publishers may split the opening bracket and author across linked objects.
// For repeated, unchanged dated citations, use their complete identity and
// occurrence; a repeated author fragment alone does not prove a destination.
function literalBracketCitation(source, translation, label, offset) {
  // A publisher can link only the "a" in "2013b,a" or split a semicolon
  // citation over rows. The complete closed list must remain byte-for-byte
  // identical; neither a bare suffix nor a changed author/year proves a link.
  const entry = `${author}\\s+et\\s+al\\.,\\s*\\d{4}(?:[a-z](?:,\\s*[a-z])*)?`
  const citations = [...source.matchAll(new RegExp(`\\[${entry}(?:;\\s*${entry})*\\]`, 'gu'))]
  const citation = citations.find(
    (match) => match.index <= offset && offset + label.length <= match.index + match[0].length
  )
  if (!citation || source.slice(offset, offset + label.length) !== label) return null
  const pattern = new RegExp(citation[0].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')
  const from = [...source.matchAll(pattern)],
    to = [...translation.matchAll(pattern)]
  const occurrence = from.findIndex((match) => match.index === citation.index)
  return from.length === to.length && occurrence >= 0
    ? { start: to[occurrence].index + offset - citation.index, text: label }
    : null
}

// A split link can own the conjunction and a multiword second author. Prove
// its complete parenthesized dated pair first; a suffix alone cannot identify
// either the first author or the year. Preserve word boundaries inside names.
function datedCompoundPairFragment(source, translation, label, offset) {
  const pattern = new RegExp(
    `[(（]\\s*(${authorName})\\s*((?:&|and\\s+|[和与與])\\s*(${authorName}))[,，]\\s*(\\d{4}[a-z]?)\\s*年?[)）]`,
    'gu'
  )
  const references = (text) => [...text.matchAll(pattern)]
  const names = (reference) =>
    [reference[1], reference[3]].map((name) => name.normalize('NFC').replace(/\s+/gu, ' '))
  const parts = (reference) => {
    const first = reference[0].indexOf(reference[1]),
      tail = reference[0].indexOf(reference[2], first + reference[1].length)
    return [
      { offset: first, text: reference[1] },
      { offset: tail, text: reference[2] },
      { offset: tail + reference[2].lastIndexOf(reference[3]), text: reference[3] },
      { offset: reference[0].lastIndexOf(reference[4]), text: reference[4] },
      { offset: first, text: reference[0].slice(first, tail + reference[2].length) }
    ]
  }
  const all = references(source),
    translatedReferences = references(translation),
    compactNames = (item) =>
      names(item)
        .map((name) => name.replace(/\s/gu, ''))
        .join('&'),
    reference = all.find(
      (item) =>
        (names(item).some((name) => name.includes(' ')) ||
          translatedReferences.some(
            (other) =>
              other[4] === item[4] &&
              compactNames(other) === compactNames(item) &&
              names(other).some((name) => name.includes(' '))
          )) &&
        offset >= item.index + parts(item)[0].offset &&
        offset + label.length <= item.index + parts(item)[3].offset + item[4].length
    )
  if (!reference) return undefined
  const identity = names(reference).join('&'),
    same = (item) => names(item).join('&') === identity && item[4] === reference[4],
    from = all.filter(same),
    to = translatedReferences.filter(same),
    occurrence = from.findIndex((item) => item.index === reference.index)
  if (from.length !== to.length || occurrence < 0) return null
  const component = parts(reference).findIndex(
    (part) => reference.index + part.offset === offset && part.text === label
  )
  if (component < 0) return null
  const target = parts(to[occurrence])[component]
  return { start: to[occurrence].index + target.offset, text: target.text }
}

// A wrapped year link can include its closing citation bracket and full stop.
// Prove its complete ordered author/year list and occurrence in both directions.
function datedClosingReference(source, translation, label, offset) {
  if (
    !/^\d{4}[a-z]?[)）][.．。]?$/u.test(label) ||
    source.slice(offset, offset + label.length) !== label
  )
    return null
  const entry = `(${authorName}(?:\\s*(?:et\\s*al\\.|等人?|(?:&|and\\s+|[和与與])\\s*${authorName}))?)\\s*[,，]\\s*(\\d{4}[a-z]?)`,
    pattern = new RegExp(`[(（]\\s*${entry}(?:\\s*[;；]\\s*${entry})*\\s*[)）][.．。]?`, 'gu'),
    references = (text) => [...text.matchAll(pattern)],
    entries = (match) => [...match[0].matchAll(new RegExp(entry, 'gu'))],
    identity = (match) =>
      entries(match)
        .map((item) => [
          item[1]
            .normalize('NFC')
            .replace(/\s*(?:et\s*al\.|等人?)$/u, ':et-al')
            .replace(/\s*(?:&|\band\s+|[和与與])\s*/gu, '&')
            .trim()
            .replace(/\s+/gu, ' '),
          item[2]
        ])
        .map((item) => item.join(':'))
        .join(';'),
    suffix = (match) => {
      const terminal = match[0].match(/\d{4}[a-z]?[)）]([.．。])?$/u)?.[0]
      if (!terminal || (/[.．。]$/u.test(label) && !/[.．。]$/u.test(terminal))) return null
      const text = /[.．。]$/u.test(label) ? terminal : terminal.replace(/[.．。]$/u, '')
      return { start: match.index + match[0].lastIndexOf(terminal), text }
    },
    all = references(source),
    reference = all.find((match) => {
      const tail = suffix(match)
      return tail?.start === offset && tail.text === label
    })
  if (!reference) return null
  // A list's terminal year belongs to its complete ordered author/year list,
  // not another citation with the same year or a moved closing bracket.
  const same = (match) => identity(match) === identity(reference),
    from = all.filter(same),
    to = references(translation).filter(same),
    occurrence = from.findIndex((match) => match.index === reference.index)
  return from.length === to.length && occurrence >= 0 ? suffix(to[occurrence]) : null
}

// An annotation may cover a whole unnumbered notice. Its prepared translation
// is the entire linked label; no substring or inferred semantic match is needed.
// Keep scientific identities, numeric values, URLs and standalone names outside
// this path. Native ownership, hit areas and actions are checked by both callers.
function wholeProseLink(source, translation, label, offset) {
  const prose = (text) =>
    !/[\p{C}\p{N}:/]/u.test(text) &&
    !pdfLinkLabelKey(text) &&
    ![...citationMatches(text)].length &&
    (((text.match(/\b[A-Za-zÀ-ÖØ-öø-ÿ]+\b/gu)?.length ?? 0) >= 2 &&
      /(?:^|\s)[a-zà-öø-ÿ]+/u.test(text)) ||
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2}/u.test(text))
  const original = source.trim(),
    target = translation.trim()
  return label === original &&
    source.indexOf(original) === offset &&
    prose(original) &&
    prose(target)
    ? { start: translation.indexOf(target), text: target }
    : null
}

export function translatedPdfLinkLabel(source, translation, label, offset) {
  const closing = datedClosingReference(source, translation, label, offset)
  if (closing) return closing
  const compound = datedCompoundPairFragment(source, translation, label, offset)
  if (compound !== undefined) return compound
  const key = pdfLinkLabelKey(label)
  if (key?.startsWith('authors:&')) {
    const pair = [...citationMatches(source)].find(
      (match) =>
        match.index < offset &&
        /[(（]\s*$/u.test(source.slice(0, match.index)) &&
        match.index + match[0].length === offset + label.length
    )
    if (pair) {
      const year = source
          .slice(pair.index + pair[0].length)
          .match(/^[,，]\s*\d{4}[a-z]?(?![A-Za-z\d])/u),
        whole = pair[0] + (year?.[0] ?? ''),
        target = translatedPdfLinkLabel(source, translation, whole, pair.index)
      if (!target) return null
      const suffix = pdfLinkLabelMatches(target.text, label)
      return suffix.length === 1
        ? { start: target.start + suffix[0].index, text: suffix[0][0] }
        : null
    }
  }
  if (!key)
    return (
      superscriptFootnote(source, translation, label, offset) ??
      literalBracketCitation(source, translation, label, offset) ??
      datedLiteralCitation(source, translation, label, offset) ??
      datedCollectiveTail(source, translation, label, offset) ??
      wholeProseLink(source, translation, label, offset)
    )
  const authorWords = (text) =>
      text
        .normalize('NFKC')
        .trim()
        .match(
          new RegExp(`^(${authorName})\\s*(?:&|and\\s+|[和与與])\\s*(${authorName})[,，]?$`, 'u')
        )
        ?.slice(1)
        .map((name) => name.trim().replace(/\s+/gu, ' ')),
    words = authorWords(label),
    from = pdfLinkLabelMatches(source, label),
    to = pdfLinkLabelMatches(translation, label).filter(
      (match) =>
        !words?.some((name) => name.includes(' ')) ||
        authorWords(match[0])?.join('&') === words.join('&')
    )
  const bareLabel = label.replace(/[,，]$/u, '')
  // A native PDF label can contain NBSP or narrow NBSP where the prepared source has an
  // ordinary space. Keep the original source indices and equal-length literal
  // ownership; neither collapsing spaces nor finding a nearby label is proof.
  const sameSpacing = (text) => text.replace(/[\u00a0\u202f]/gu, ' ')
  const index = from.findIndex(
    (match) =>
      match.index === offset &&
      (sameSpacing(match[0]) === sameSpacing(bareLabel) ||
        (key.startsWith('supplementary-figure:') &&
          !bareLabel.endsWith('.') &&
          sameSpacing(match[0]) === sameSpacing(bareLabel) + '.' &&
          sameSpacing(source.slice(offset, offset + bareLabel.length)) === sameSpacing(bareLabel)))
  )
  if (index < 0) return null
  let target = from.length === to.length ? to[index] : undefined
  // A translation may repeat a table/figure reference while expanding prose.
  // One admitted source reference keeps its action on the first same-identity
  // target mention; extra mentions are text, not invented annotations.
  if (!target && from.length === 1 && to.length > 1 && /^(?:table|figure):/u.test(key))
    target = to[0]
  if (key.startsWith('authors:')) {
    // Prose can spell an author differently from the parenthesized citation.
    // A unique, unchanged citation year proves the linked occurrence without
    // treating an unlinked translated author name as the same Latin identity.
    const yearAt = (text, match) => {
      const before = text.slice(0, match.index),
        after = text.slice(match.index + match[0].length),
        year = after.match(/^[,，]\s*(\d{4}[a-z]?)\s*年?[)）]/u)
      const narrative = after.match(/^\s*[(（]\s*(\d{4}[a-z]?)\s*年?[)）]/u)
      if (/^\s*[(（]\s*\d{4}/u.test(after))
        return /[\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'\u{1d400}-\u{1d7ff}]/u.test(
          [...before].at(-1) ?? ''
        )
          ? null
          : (narrative?.[1] ?? null)
      return /[(（]\s*$/u.test(before) ? year?.[1] : undefined
    }
    const year = yearAt(source, from[index])
    if (year === null) return null
    if (year) {
      const origins = from.filter((match) => yearAt(source, match) === year)
      const candidates = to.filter((match) => yearAt(translation, match) === year)
      if (
        origins.length !== candidates.length ||
        (from.length !== to.length &&
          (/^\s*[(（]/u.test(source.slice(from[index].index + from[index][0].length)) ||
            candidates.some((match) =>
              /^\s*[(（]/u.test(translation.slice(match.index + match[0].length))
            )))
      )
        return null
      target = candidates[origins.findIndex((match) => match.index === offset)]
    }
  }
  if (!target) return null
  // A comma covered by the source hit area remains part of the localized label.
  const comma =
    label.length > bareLabel.length
      ? translation.slice(target.index + target[0].length).match(/^[,，]/u)?.[0]
      : ''
  if (label.length > bareLabel.length && !comma) return null
  return { start: target.index, text: target[0] + (comma ?? '') }
}

// A citation number belongs to its complete closed list, not an unrelated
// month or measurement. Only bracket/comma presentation can be localized;
// complete-list occurrences and ordered numeric identities must agree.
// Undefined leaves non-citation labels on their existing path; null forbids a
// bare-number fallback after a complete source citation fails identity proof.
export function translatedPdfBracketedReference(source, translation, label, offset) {
  if (!/^\d{1,4}$/u.test(label) || source.slice(offset, offset + label.length) !== label)
    return undefined
  const blocks = (text) =>
    [
      ...text.matchAll(
        /\[\s*\d{1,4}(?:\s*[,，]\s*\d{1,4})*\s*\]|［\s*\d{1,4}(?:\s*[,，]\s*\d{1,4})*\s*］/gu
      )
    ].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      numbers: [...match[0].matchAll(/\d+/gu)]
    }))
  const from = blocks(source),
    to = blocks(translation),
    block = from.find((b) => b.numbers.some((n) => b.start + n.index === offset && n[0] === label))
  if (!block) return undefined
  const identity = (b) => b.numbers.map((n) => n[0]).join(','),
    key = identity(block),
    sourceMatches = from.filter((b) => identity(b) === key),
    targetMatches = to.filter((b) => identity(b) === key)
  if (!sourceMatches.length || sourceMatches.length !== targetMatches.length) return null
  const occurrence = sourceMatches.indexOf(block),
    ordinal = block.numbers.findIndex((n) => block.start + n.index === offset),
    target = targetMatches[occurrence],
    start = target.start + target.numbers[ordinal].index
  return {
    start,
    end: start + label.length,
    text: label,
    sourceBlock: { start: block.start, end: block.end, text: block.text },
    targetBlock: { start: target.start, end: target.end, text: target.text }
  }
}

// A publisher can wrap this notice between its two words. Localize only exact
// components of the complete, equally repeated phrase, never a bare occurrence
// of "information" elsewhere in the paragraph. Native hit areas/actions still
// need their independent writer and reader proofs.
function supportingInformationFragment(source, translation, label, offset) {
  if (!/^(?:Supporting|information|支持|信息|資訊|材料)$/iu.test(label)) return undefined
  const from = [...source.matchAll(supportingInformation)],
    to = [...translation.matchAll(supportingInformation)],
    parts = (match) => {
      const split = match[0].match(/^(Supporting)(\s+)(information)$/iu)
      return split
        ? [
            { start: match.index, text: split[1] },
            { start: match.index + split[1].length + split[2].length, text: split[3] }
          ]
        : [
            { start: match.index, text: match[0].slice(0, 2) },
            { start: match.index + 2, text: match[0].slice(2) }
          ]
    },
    occurrence = from.findIndex((match) =>
      parts(match).some((part) => part.start === offset && part.text === label)
    )
  if (occurrence < 0 || from.length !== to.length) return null
  const component = parts(from[occurrence]).findIndex(
      (part) => part.start === offset && part.text === label
    ),
    target = parts(to[occurrence])[component]
  return target ? { start: target.start, text: target.text } : null
}

// A line break can divide one author citation across two link rectangles. Map
// only a literal slice of its unchanged full author name, optionally followed by
// the entire localized collective-author marker. Hyphen glyph proof belongs to
// the native writer: this helper accepts no control characters or invented name.
export function translatedPdfLinkFragment(source, translation, label, offset) {
  const supporting = supportingInformationFragment(source, translation, label, offset)
  if (supporting !== undefined) return supporting
  const bracketed = translatedPdfBracketedReference(source, translation, label, offset)
  if (bracketed !== undefined)
    return bracketed ? { start: bracketed.start, text: bracketed.text } : null
  const closing = datedClosingReference(source, translation, label, offset)
  if (closing) return closing
  const whole = wholeProseLink(source, translation, label, offset)
  if (whole) return whole
  const compound = datedCompoundPairFragment(source, translation, label, offset)
  if (compound !== undefined) return compound
  if (!label || /[\p{C}]/u.test(label) || source.slice(offset, offset + label.length) !== label)
    return null
  // The opening bracket can share its native link with a collective author.
  // Keep it only with the complete closed author/year identity and occurrence.
  if (/^[[［]/u.test(label)) {
    const pattern = new RegExp(
        `[\\[［]\\s*(${author}\\s*(?:et\\s*al\\.|等人?))[,，]\\s*(\\d{4}[a-z]?)\\s*[\\]］]`,
        'gu'
      ),
      references = (text) => [...text.matchAll(pattern)],
      reference = references(source).find(
        (match) =>
          match.index === offset &&
          match[0].startsWith(label) &&
          label === match[0].slice(0, match[0].indexOf(match[1]) + match[1].length)
      ),
      identity = (match) => `${pdfLinkLabelKey(match[1])}:${match[2]}`
    if (reference) {
      const from = references(source).filter((match) => identity(match) === identity(reference)),
        to = references(translation).filter((match) => identity(match) === identity(reference)),
        occurrence = from.findIndex((match) => match.index === offset)
      if (from.length !== to.length || occurrence < 0) return null
      const target = to[occurrence]
      return {
        start: target.index,
        text: target[0].slice(0, target[0].indexOf(target[1]) + target[1].length)
      }
    }
  }
  // A wrapped URL can share a short fragment ("www.") with other addresses.
  // Resolve the complete literal address and its occurrence before locating
  // that fragment. Only spaces after URL separators can be native line wraps.
  const addresses = pdfLinkAddressMatches
  const address = addresses(source).find(
    (match) => offset >= match.index && offset + label.length <= match.index + match.text.length
  )
  if (address) {
    const identity = address.text.replace(/ /gu, ''),
      same = (match) => match.text.replace(/ /gu, '') === identity,
      from = addresses(source).filter(same),
      to = addresses(translation).filter(same),
      occurrence = from.findIndex((match) => match.index === address.index),
      start = address.text.slice(0, offset - address.index).replace(/ /gu, '').length
    if (from.length !== to.length || occurrence < 0) return null
    const target = to[occurrence],
      compactLabel = label.replace(/ /gu, ''),
      end = start + compactLabel.length,
      positions = [...target.text.matchAll(/[^ ]/gu)].map((match) => match.index),
      targetStart = positions[start],
      targetEnd = positions[end - 1]
    // Keep an exact slice of the proven target address. The inverse mapping
    // also verifies reader labels against the source's native wrap spaces.
    return identity.slice(start, end) === compactLabel &&
      targetStart !== undefined &&
      targetEnd !== undefined
      ? { start: target.index + targetStart, text: target.text.slice(targetStart, targetEnd + 1) }
      : null
  }
  // A figure/table link can wrap between its prefix and number. Match the
  // complete numbered identity, then localize only its proven prefix.
  if (/^(?:Table|Tab\.?|Figure|Fig\.?|Theorem|表|图|圖|定理)$/iu.test(label)) {
    const reference = [...source.matchAll(labels)].find(
      (match) => match.index === offset && match[0].startsWith(label)
    )
    if (!reference) return null
    const target = translatedPdfLinkLabel(source, translation, reference[0], reference.index),
      prefix = target?.text.match(/^\D+?(?=\s*\d+$)/u)?.[0]?.trimEnd()
    return prefix ? { start: target.start, text: prefix } : null
  }
  // Some publishers link only the second suffix in (Author, 2020b,a).
  // Bind it to the entire closed author/year group, including other references;
  // an unrelated article 'a' or a changed/reordered year list proves nothing.
  if (/^[a-z]$/u.test(label)) {
    const component = new RegExp(
        `^${author}\\s*(?:et\\s*al\\.|等人?)?\\s*[,，]\\s*\\d{4}[a-z]?(?:\\s*[,，]\\s*(?:\\d{4}[a-z]?|[a-z]))*$`,
        'u'
      ),
      groups = (text) =>
        [...text.matchAll(/[(（]([^()（）]+)[)）]/gu)].flatMap((match) => {
          const parts = match[1].split(/[;；]/u).map((part) => part.trim())
          if (!parts.every((part) => component.test(part))) return []
          const key = parts
              .map((part) =>
                part
                  .replace(/et\s*al\.|等人?/gu, '@')
                  .replace(/，/gu, ',')
                  .replace(/\s/gu, '')
              )
              .join(';'),
            suffixes = [...match[1].matchAll(/[,，]\s*([a-z])(?=\s*(?:[,，;；]|$))/gu)].map(
              (suffix) => ({
                label: suffix[1],
                offset: match.index + 1 + suffix.index + suffix[0].lastIndexOf(suffix[1])
              })
            )
          return [{ key, suffixes }]
        }),
      reference = groups(source).find((group) =>
        group.suffixes.some((suffix) => suffix.offset === offset && suffix.label === label)
      )
    if (reference) {
      const from = groups(source).filter((group) => group.key === reference.key),
        to = groups(translation).filter((group) => group.key === reference.key),
        suffixIndex = reference.suffixes.findIndex((suffix) => suffix.offset === offset)
      const index = from.findIndex((group) =>
        group.suffixes.some((suffix) => suffix.offset === offset)
      )
      if (from.length !== to.length || index < 0) return null
      const target = to[index]?.suffixes[suffixIndex]
      return target?.label === label ? { start: target.offset, text: label } : null
    }
  }
  // A wrapped citation can link a suffix-bearing year independently. Match
  // its complete author and ordered year list, never a bare repeated year.
  if (/^\d{4}[a-z]$/u.test(label)) {
    // Keep each linked year bound to a complete closed author/year citation,
    // including parenthetical and narrative presentations in either language.
    // a repeated bare year cannot establish the link's author or destination.
    const yearList = '\\d{4}[a-z]?(?:\\s*[,，]\\s*\\d{4}[a-z]?)*',
      closed = new RegExp(
        `(?:[(（]\\s*${author}\\s*(?:et\\s*al\\.|等人?)?\\s*[,，]\\s*${yearList}\\s*[)）]|(?<![\\p{Script=Latin}\\p{Script=Greek}\\p{N}\\p{M}_′″‴'\\u{1d400}-\\u{1d7ff}])${author}\\s*(?:et\\s*al\\.|等人?)?\\s*[(（]\\s*${yearList}\\s*[)）])`,
        'gu'
      ),
      matches = (text) =>
        [...text.matchAll(closed)].filter((match) =>
          [...match[0].matchAll(/\d{4}[a-z]?/gu)].some((year) => year[0] === label)
        ),
      from = matches(source),
      to = matches(translation),
      labelOffset = (match) => match.index + match[0].lastIndexOf(label),
      occurrence = from.findIndex((match) => labelOffset(match) === offset),
      key = (match) => {
        const text = match[0].replace(/^[(（]\s*/u, '').slice(0, -1),
          years = text.match(/\d{4}[a-z]?/gu),
          identity = pdfLinkLabelKey(text.slice(0, text.search(/\d{4}/u)) + years[0])
        return identity ? `${identity}:${years.join(',')}` : null
      },
      count = (text) =>
        [...text.matchAll(new RegExp(`(?<![A-Za-z\\d])${label}(?![A-Za-z\\d])`, 'gu'))].length
    if (occurrence >= 0)
      return from.length === to.length &&
        count(source) === from.length &&
        count(translation) === to.length &&
        from.every((match, index) => key(match) && key(match) === key(to[index]))
        ? { start: labelOffset(to[occurrence]), text: label }
        : null
    const pattern = new RegExp(
        `(?<![A-Za-zÀ-ÖØ-öø-ÿ])(${author})\\s*(?:et\\s*al\\.|等人?)\\s*[,，]\\s*(\\d{4}[a-z]?(?:\\s*[,，]\\s*\\d{4}[a-z]?)*)(?![A-Za-z\\d]|\\s*[,，]\\s*\\d)`,
        'gu'
      ),
      citations = (text) => [...text.matchAll(pattern)],
      years = (match) => [...match[2].matchAll(/\d{4}[a-z]?/gu)].map((year) => year[0]),
      reference = citations(source).find(
        (match) => offset >= match.index && offset + label.length <= match.index + match[0].length
      )
    if (reference) {
      const same = (match) =>
          match[1] === reference[1] && years(match).join(',') === years(reference).join(','),
        from = citations(source).filter(same),
        to = citations(translation).filter(same),
        occurrence = from.findIndex((match) => match.index === reference.index),
        candidates = (match) => [...match[0].matchAll(/(?<![A-Za-z\d])\d{4}[a-z](?![A-Za-z\d])/gu)],
        yearIndex = candidates(reference).findIndex(
          (year) => reference.index + year.index === offset
        )
      if (from.length !== to.length || yearIndex < 0) return null
      const target = to[occurrence],
        year = candidates(target)[yearIndex]
      return year ? { start: target.index + year.index, text: label } : null
    }
    return null
  }
  // Caption links can include their terminal period. Prove the complete
  // numbered reference identity before moving the fragment; punctuation alone
  // proves no destination.
  const punctuated = label.match(/^(.+)([.．。])$/u)
  if (punctuated && /^\d{1,4}$/u.test(punctuated[1])) {
    const reference = [...source.matchAll(labels)].find(
      (match) =>
        /^(?:table|figure):/u.test(pdfLinkLabelKey(match[0]) ?? '') &&
        match[0].match(/\d+$/u)?.[0] === punctuated[1] &&
        match.index + match[0].length - punctuated[1].length === offset &&
        !/^[.．][\p{L}\p{N}\p{M}_]/u.test(source.slice(match.index + match[0].length))
    )
    if (reference) {
      if (
        pdfLinkLabelMatches(source, reference[0]).length !==
        pdfLinkLabelMatches(translation, reference[0]).length
      )
        return null
      const target = translatedPdfLinkLabel(source, translation, reference[0], reference.index),
        punctuation = target && translation[target.start + target.text.length]
      return target &&
        target.text.match(/\d+$/u)?.[0] === punctuated[1] &&
        /^[.．。]$/u.test(punctuation ?? '') &&
        !/^[.．][\p{L}\p{N}\p{M}_]/u.test(translation.slice(target.start + target.text.length))
        ? {
            start: target.start + target.text.length - punctuated[1].length,
            text: punctuated[1] + punctuation
          }
        : null
    }
  }
  if (punctuated && /^(?:table|figure|theorem):/u.test(pdfLinkLabelKey(punctuated[1]) ?? '')) {
    const target = translatedPdfLinkLabel(source, translation, punctuated[1], offset),
      punctuation = target && translation[target.start + target.text.length]
    return target && /^[.．。]$/u.test(punctuation ?? '')
      ? { start: target.start, text: target.text + punctuation }
      : null
  }
  // Table-caption footnotes can touch the last word ("Baselinea,b"). Match
  // their complete trailing marker list, not occurrences of "a" inside prose.
  if (/^[a-z]$/u.test(label)) {
    const caption = /^\s*(?:Table\s+|表\s*)(\d+)\b/iu,
      sourceCaption = source.match(caption),
      targetCaption = translation.match(caption),
      markers = /[a-z](?:[,，]\s*[a-z])*\s*$/u,
      from = source.match(markers),
      to = translation.match(markers)
    if (sourceCaption && sourceCaption[1] === targetCaption?.[1] && from && to) {
      const before = [...from[0].matchAll(/[a-z]/gu)],
        after = [...to[0].matchAll(/[a-z]/gu)],
        index = before.findIndex((match) => from.index + match.index === offset)
      if (
        index >= 0 &&
        before.map((match) => match[0]).join('') === after.map((match) => match[0]).join('')
      )
        return { start: to.index + after[index].index, text: label }
    }
    return null
  }
  const tail = datedCollectiveTail(source, translation, label, offset)
  if (tail) return tail
  // A publisher may link only the number in "Fig. 2B" or "Figure 2(a)". Resolve the entire
  // panel identity before locating that digit; POD2 or an added "day 2" must
  // not shift its occurrence. Repeated panels require matching counts.
  if (/^\d+[A-Za-z]?$/u.test(label)) {
    const panels = (text) => [
        ...text.matchAll(
          /(?:\b(?:Figure|Fig\.?)\s*|[图圖]\s*)(\d+(?:[A-Za-z]|[（(]\s*[A-Za-z]\s*[)）]))(?![A-Za-z\d])/gu
        )
      ],
      identity = (match) => match[1].normalize('NFKC').replace(/\s/gu, '')
    const reference = panels(source).find(
      (match) =>
        match.index + match[0].length - match[1].length === offset && match[1].startsWith(label)
    )
    if (reference) {
      const from = panels(source).filter((match) => identity(match) === identity(reference)),
        to = panels(translation).filter((match) => identity(match) === identity(reference)),
        index = from.findIndex((match) => match.index === reference.index)
      if (from.length !== to.length) return null
      const target = to[index]
      return { start: target.index + target[0].length - target[1].length, text: label }
    }
  }
  const number = label.match(/^(\d+)(\.)?$/u)
  if (number) {
    const reference = [...source.matchAll(labels)].find(
      (candidate) =>
        /^(?:table|figure|theorem):/u.test(pdfLinkLabelKey(candidate[0]) ?? '') &&
        (!number[2] || pdfLinkLabelKey(candidate[0])?.startsWith('theorem:')) &&
        candidate.index + candidate[0].length - number[1].length === offset &&
        candidate[0].endsWith(number[1])
    )
    if (!reference) return null
    const target = translatedPdfLinkLabel(source, translation, reference[0], reference.index)
    return target && target.text.endsWith(number[1])
      ? { start: target.start + target.text.length - number[1].length, text: number[1] }
      : null
  }
  const match = [...citationMatches(source)].find(
    (candidate) =>
      candidate.index <= offset && candidate.index + candidate[0].length >= offset + label.length
  )
  if (!match) {
    const dated = [
      ...source.matchAll(
        new RegExp(`[(（]\\s*(${author}(?: ${author}){0,3})[,，]\\s*\\d{4}[a-z]?\\s*[)）]`, 'gu')
      )
    ].find((candidate) => {
      const start = candidate.index + candidate[0].indexOf(candidate[1])
      return offset >= start && offset + label.length <= start + candidate[1].length
    })
    if (!dated) return null
    const start = dated.index + dated[0].indexOf(dated[1]),
      target = datedLiteralCitation(source, translation, dated[1], start)
    return target ? { start: target.start + offset - start, text: label } : null
  }
  const target = translatedPdfLinkLabel(source, translation, match[0], match.index)
  if (!target) return null
  const start = offset - match.index,
    withinPair = translatedPdfLinkLabel(match[0], target.text, label, start)
  if (withinPair) return { start: target.start + withinPair.start, text: withinPair.text }
  const key = pdfLinkLabelKey(match[0])
  if (key?.startsWith('authors:') && key.includes('&')) {
    // A two-author citation can wrap between its names. Preserve literal slices
    // only after the complete pair identity has matched on both sides.
    const names = [...match[0].matchAll(new RegExp(author, 'gu'))]
    const component = names.find(
      (name) => start >= name.index && start + label.length <= name.index + name[0].length
    )
    if (!component) {
      const first = names[0],
        second = names[1]
      if (
        start !== first?.index ||
        !second ||
        label.slice(0, first[0].length) !== first[0] ||
        !/^(?:and|[&和与與])$/u.test(
          match[0].slice(first[0].length, Math.min(start + label.length, second.index)).trim()
        ) ||
        start + label.length > second.index + second[0].length
      )
        return null
      const targetNames = [...target.text.matchAll(new RegExp(author, 'gu'))]
      if (
        targetNames.length !== 2 ||
        targetNames[0][0] !== first[0] ||
        targetNames[1][0] !== second[0]
      )
        return null
      const prefix = target.text
        .slice(0, targetNames[1].index + Math.max(0, start + label.length - second.index))
        .trimEnd()
      return { start: target.start, text: prefix }
    }
    const targetName = [...target.text.matchAll(new RegExp(author, 'gu'))][names.indexOf(component)]
    if (!targetName || targetName[0] !== component[0]) return null
    return { start: target.start + targetName.index + start - component.index, text: label }
  }
  if (!key?.endsWith(':et-al')) return null
  const name = key.slice('authors:'.length, -':et-al'.length),
    end = start + label.length
  if (!target.text.startsWith(name) || (end > name.length && end !== match[0].length)) return null
  if (start >= name.length) {
    if (match[0].slice(name.length).trim() !== label) return null
    const tail = target.text.slice(name.length).trimStart()
    return { start: target.start + target.text.length - tail.length, text: tail }
  }
  return {
    start: target.start + start,
    text: target.text.slice(start, end <= name.length ? end : undefined)
  }
}
