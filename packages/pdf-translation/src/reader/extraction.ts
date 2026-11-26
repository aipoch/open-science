import { nativeBundledScientificOwners } from './native-bundled-scientific-table.js'
import { unreliablyDecodedDisplayOwners } from './native-unreliably-decoded-displays.js'
import { readNativeFormClippedText } from './native-form-clipped-text.js'
import { rememberPdfTranslationSourceParser } from './snapshot.js'
import { readNativeOccludedText } from './native-occluded-text.js'
import { createNativeRuledAlgorithmCaptionReader } from './ruled-algorithm-packets.js'
import { createNativeTaggedReferenceReader } from './tagged-reference-packets.js'
import { terminalContactSources } from './terminal-contact-source.js'
import { readNativeCommandAdvances } from './compound-reference-boundary.js'
import {
  readNativeAppendixOverview,
  readNativeOutlineRestart,
  readNativeOnlineAppendixRestart,
  readNativeContentsReference,
  createNativeTerminalCaptionReader,
  bindNativeTerminalCaptionLayout
} from './appendix-overview-boundary.js'
import { getPdfTranslationTextContent } from './text-content.js'
import { rememberNativeCaptionTerminal } from './caption-terminal.js'
import { nativeOwnedReferenceRolesCurrent } from './unheaded-reference-packets.js'
import {
  readNativeReferenceEvidence,
  readNativeTableNoteEvidence,
  readNativeDisplayEquationEvidence,
  readNativeDerivativeRuleEvidence,
  readNativeNumberedPacketEvidence,
  readNativeCompactAlgorithmEvidence,
  bindNativeReferenceRolePage,
  nativeReferenceRolePagesCurrent
} from './native-reference-evidence.js'
import { readNativeSectionFontEvidence } from './wrapped-section-prose.js'
import type { PDFDocumentProxy, PDFPageProxy, getDocument } from 'pdfjs-dist'
import {
  createAuxiliaryNativeExclusionReader,
  createAuxiliaryNativeDisplayInkReader
} from './auxiliary-native-ink.js'
import {
  hasNativeDisplaySequence,
  hasNativeNestedIntegralMarker,
  hasNativeStackedFractionMarker,
  hasNativeEncodedRadicalMarker,
  nativeScopedDisplayOwners,
  nativeDisplayProductTerms
} from './native-display-packets.js'
import {
  hasNativeShortMathContinuation,
  nativeShortMathContinuations
} from './native-short-math-continuation.js'
import { hasNativeLiteralMathCandidate, nativeLiteralMathOwners } from './native-literal-math.js'
import {
  hasNativeDerivativeMatrixCandidate,
  hasNativeMatrixCandidate,
  createNativeMatrixReader,
  nativeMatrixOwners
} from './native-matrix-packets.js'
import {
  hasNativeFunctionDisplay,
  createNativeFunctionDisplayReader,
  nativeFunctionDisplayOwners
} from './native-function-display.js'
import { nativeTableCaptionOwners } from './native-table-caption.js'
import { rememberNativeCaptionEligibility } from './caption-eligibility.js'
import { nativePartialNavigation } from './native-source-geometry.js'
import { readOutlierFontNavigation, readNativeType3Navigation } from './outlier-font-navigation.js'
import { createPdfTranslationSource, type PdfTranslationSource } from './source.js'
import {
  groupPdfTranslationPages,
  type PdfTranslationLayout,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from './layout.js'
import {
  readPdfMathDiagrams,
  preservePdfMathDiagrams,
  type PdfMathDiagram
} from './math-diagram.js'

export type PdfTranslationExclusionReason =
  'invalid-geometry' | 'unsupported-orientation' | 'outside-page' | 'occluded-native-text'

export type PdfTranslationExtraction = Readonly<{
  source: PdfTranslationSource
  /** Source coverage only: included text is not necessarily prose or a correct translation. */
  coverage: Readonly<{
    pageCount: number
    textItemCount: number
    includedItemCount: number
    excludedItemCount: number
    pagesWithoutText: readonly number[]
    exclusions: readonly Readonly<{
      unitId?: string
      reason: PdfTranslationExclusionReason
      items: readonly Readonly<{
        pageNumber: number
        index: number
        text: string
      }>[]
    }>[]
    /** Advisory grouping or decoding uncertainty; never silently removes source text. */
    warnings: readonly Readonly<{
      unitId: string
      reasons: readonly string[]
    }>[]
    /** Painted glyphs without a native text owner; does not change translation eligibility. */
    pageDiagnostics?: readonly Readonly<{
      pageNumber: number
      reason: 'unreliable-font-unicode'
    }>[]
  }>
}>

// A raised tensor operator precedes its parenthesized argument on a lower baseline.
function isNativeTensorPower(items: readonly PdfLayoutTextItem[], index: number): boolean {
  const operator = items[index],
    exponent = items[index + 1],
    opening = items[index + 2]
  if (
    operator?.str !== '⊗' ||
    !exponent ||
    !/^[1-9]\d?$/u.test(exponent.str) ||
    opening?.str !== '(' ||
    operator.hasEOL ||
    exponent.hasEOL ||
    ![operator, exponent, opening].every(({ dir, width, height, transform, fontVertical }) => {
      const [a, b, c, d] = transform
      return (
        dir === 'ltr' &&
        !fontVertical &&
        width > 0 &&
        height > 0 &&
        a > 0 &&
        b === 0 &&
        c === 0 &&
        d > 0 &&
        [width, height, ...transform].every(Number.isFinite)
      )
    })
  )
    return false

  const em = opening.height
  const near = (value: number, min: number, max: number): boolean =>
    value >= min * em && value <= max * em
  return (
    near(operator.height, 0.95, 1.05) &&
    near(exponent.height, 0.6, 0.8) &&
    near(operator.transform[5] - opening.transform[5], 0.65, 0.85) &&
    near(exponent.transform[5] - opening.transform[5], 0.42, 0.6) &&
    near(exponent.transform[4] - operator.transform[4] - operator.width, -0.06, 0.12) &&
    near(opening.transform[4] - exponent.transform[4] - exponent.width, -0.02, 0.12)
  )
}

// The differential immediately after a stacked inner-product fraction is part of the equation.
function preserveFractionDifferentials(
  units: PdfTranslationSource['units'],
  pages: PdfLayoutPage[]
): PdfTranslationSource['units'] {
  return units.map((unit, index) => {
    if (
      unit.sourceOnly ||
      unit.preserve ||
      unit.figure ||
      unit.referenceBoundary ||
      !/^d[A-Za-z],$/u.test(unit.source) ||
      unit.fragments.length !== 1
    )
      return unit
    const [fragment] = unit.fragments
    const denominator = units[index + 1]
    const lower = denominator?.fragments[0]
    if (
      fragment.unclippedRect ||
      fragment.items.length !== 1 ||
      denominator?.preserve !== 'formula' ||
      !denominator.sourceOnly ||
      denominator.fragments.length !== 1 ||
      !lower ||
      lower.unclippedRect ||
      lower.pageNumber !== fragment.pageNumber ||
      lower.items.length !== 3
    )
      return unit
    const page = pages.find((candidate) => candidate.page === fragment.pageNumber)
    if (!page || page.rotation !== 0) return unit
    const bracketItems = lower.items.map(({ index }) => page.items[index])
    const [left, middle, right] = bracketItems
    const { index: at } = fragment.items[0]
    const differential = page.items[at]
    const before = page.items
      .slice(Math.max(0, lower.items[0].index - 4), lower.items[0].index)
      .filter((item) => item.str.trim())
    const last = before.at(-1)
    const numerator = last?.height === differential?.height ? last : before.at(-2)
    if (
      !numerator ||
      ![left, middle, right, differential, numerator].every(
        (item) =>
          item &&
          item.dir === 'ltr' &&
          item.fontName &&
          item.fontVertical === false &&
          [...item.transform, item.width, item.height].every(Number.isFinite) &&
          item.width > 0 &&
          item.height > 0 &&
          item.transform[0] > 0 &&
          item.transform[1] === 0 &&
          item.transform[2] === 0 &&
          item.transform[3] === item.height
      )
    )
      return unit
    const x = (item: PdfLayoutTextItem): number => item.transform[4]
    const y = (item: PdfLayoutTextItem): number => item.transform[5]
    const em = differential.height
    const gap = x(differential) - x(right) - right.width
    if (
      fragment.items[0].text !== differential.str ||
      differential.str !== unit.source ||
      !lower.items.every(({ text }, i) => text === bracketItems[i].str) ||
      lower.items[2].index >= at ||
      page.items.slice(lower.items[2].index + 1, at).some((item) => item.str.trim()) ||
      left.str !== '⟨' ||
      right.str !== '⟩' ||
      !/^\p{L},\s\p{L}$/u.test(middle.str) ||
      !/^\p{Script=Greek}$/u.test(numerator.str) ||
      ![left, middle, right, numerator].every((item) => item.height === em) ||
      left.fontName !== right.fontName ||
      differential.fontName !== middle.fontName ||
      differential.fontName !== numerator.fontName ||
      Math.abs(y(left) - y(middle)) > em * 0.02 ||
      Math.abs(y(left) - y(right)) > em * 0.02 ||
      Math.abs(y(left) - y(differential) + em * 0.685) > em * 0.1 ||
      Math.abs(y(numerator) - y(differential) - em * 0.68) > em * 0.1 ||
      x(numerator) < x(left) ||
      x(numerator) + numerator.width > x(right) + right.width ||
      gap < 0 ||
      gap > em * 0.45
    )
      return unit
    return { ...unit, sourceOnly: true, preserve: 'formula' }
  })
}

// The first-page email can otherwise force its linked abstract to stay untranslated.
function splitCorrespondenceFromAbstract(
  unit: PdfTranslationSource['units'][number],
  page: PdfLayoutPage
): readonly PdfTranslationSource['units'][number][] | undefined {
  if (
    page?.rotation !== 0 ||
    unit.sourceOnly ||
    unit.preserve ||
    unit.figure ||
    unit.referenceBoundary ||
    unit.fragments.length < 5 ||
    unit.fragments.some((part) => part.pageNumber !== 1)
  )
    return
  const [affiliation, contact, ...body] = unit.fragments,
    [number, ...address] = affiliation.items.map(({ index }) => page.items[index]),
    [label, email] = contact.items.map(({ index }) => page.items[index]),
    first = page.items[body[0].items[0]?.index],
    em = label?.height
  if (
    !number ||
    !label ||
    !email ||
    !first ||
    !em ||
    !address.length ||
    !/^\d+$/u.test(number.str) ||
    !/^(?:School|Department|Institute|University|Faculty|Laboratory|Centre|Center)\b/u.test(
      address[0].str
    ) ||
    !/\.$/u.test(address.at(-1)!.str.trim()) ||
    contact.items.length !== 2 ||
    !/^\*Corresponding authors?:$/iu.test(label.str.trim()) ||
    !/^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]+$/u.test(email.str.trim()) ||
    ![number, ...address, email, label, first].every(
      (item) =>
        item.dir === 'ltr' &&
        item.transform[0] > 0 &&
        item.transform[1] === 0 &&
        item.transform[2] === 0 &&
        item.transform[3] > 0
    ) ||
    !label.fontName ||
    [number, ...address, email].some((item) => item.fontName !== label.fontName) ||
    first.fontName === label.fontName ||
    number.height >= em * 0.8 ||
    number.transform[5] - label.transform[5] <= em * 2 ||
    number.transform[5] - label.transform[5] >= em * 3 ||
    label.transform[5] - first.transform[5] <= em * 1.5 ||
    label.transform[5] - first.transform[5] >= em * 2 ||
    affiliation.rect.y >= 0.31 ||
    affiliation.rect.x + affiliation.rect.width <= 0.5 ||
    Math.abs(contact.rect.x - affiliation.rect.x) > (em * 0.1) / page.width ||
    body.some(
      ({ rect }) =>
        rect.x + rect.width >= 0.5 ||
        Math.abs(rect.x - affiliation.rect.x) > (em * 0.1) / page.width
    )
  )
    return
  const affiliationText = affiliation.items.map(({ text }) => text).join(' '),
    contactText = `${label.str.trim()} ${email.str.trim()}`,
    prefix = `${affiliationText} ${contactText} `
  if (
    !unit.source.startsWith(prefix) ||
    !/^\p{Lu}[a-z]{2,} /u.test(unit.source.slice(prefix.length))
  )
    return
  return [
    {
      ...unit,
      id: `${unit.id}-affiliation`,
      source: affiliationText,
      fragments: [affiliation]
    },
    {
      ...unit,
      id: `${unit.id}-contact`,
      source: contactText,
      fragments: [contact]
    },
    { ...unit, source: unit.source.slice(prefix.length), fragments: body }
  ]
}

// Preserve the independent field rows of a first-page author template.
function splitCoverAuthorFields(
  unit: PdfTranslationSource['units'][number],
  page: PdfLayoutPage,
  block: PdfTranslationLayout['pages'][number]['blocks'][number]
): readonly PdfTranslationSource['units'][number][] | undefined {
  const [fragment] = unit.fragments,
    rows = block.lines,
    [keywords, principal, name, institution, email, authors] = rows,
    abstract = rows.at(-1),
    pitch = (principal?.y ?? 0) - (keywords?.y ?? 0),
    em = block.rect.font
  if (
    page.rotation ||
    unit.sourceOnly ||
    unit.preserve ||
    unit.figure ||
    unit.referenceBoundary ||
    unit.fragments.length !== 1 ||
    fragment.pageNumber !== 1 ||
    fragment.rect.y >= 0.4 ||
    rows.length < 9 ||
    rows.length > 40 ||
    keywords.text !== 'Keywords:' ||
    principal.text !== 'Principal Author:' ||
    !/^Name: \p{L}/u.test(name.text) ||
    !/^Institution: \p{L}/u.test(institution.text) ||
    !/^E-mail: [^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.text) ||
    authors.text !== 'Co-authors: (names and institutions)' ||
    abstract?.text !== 'Abstract (optional):' ||
    !rows.slice(6, -1).every(({ text }) => /^\p{Lu}[^():]+ \([^()]+\)$/u.test(text)) ||
    rows.map(({ text }) => text).join(' ') !== unit.source ||
    pitch < em * 1.1 ||
    pitch > em * 1.5 ||
    rows.some(
      (row, index) =>
        Math.abs(row.x - keywords.x) > em * 0.06 ||
        (index > 0 &&
          (Math.abs(row.y - rows[index - 1].y - pitch) > em * 0.06 ||
            row.y < rows[index - 1].bottom))
    )
  )
    return
  const claimed = fragment.items.map(({ index }) => '1:' + index)
  if (
    rows.flatMap(({ items }) => items).join(' ') !== claimed.join(' ') ||
    fragment.items.some(({ index, text }) => {
      const native = page.items[index]
      return (
        !native ||
        native.str !== text ||
        native.dir !== 'ltr' ||
        native.fontVertical ||
        native.transform[0] <= 0 ||
        native.transform[1] !== 0 ||
        native.transform[2] !== 0 ||
        native.transform[3] <= 0 ||
        Math.abs(native.height - em) > em * 0.03
      )
    })
  )
    return
  const rowFragments = rows.map((row) => ({
    pageNumber: 1,
    items: fragment.items.filter(({ index }) => row.items.includes('1:' + index)),
    rect: {
      x: row.x / page.width,
      y: row.y / page.height,
      width: (row.right - row.x) / page.width,
      height: (row.bottom - row.y) / page.height
    }
  }))
  const part = (
    start: number,
    end: number,
    sourceOnly = false
  ): PdfTranslationSource['units'][number] => ({
    id: unit.id + '-cover-' + start,
    source: rows
      .slice(start, end)
      .map(({ text }) => text)
      .join(' '),
    fragments: rowFragments.slice(start, end),
    ...(sourceOnly ? { sourceOnly: true, preserve: 'literal' } : {})
  })
  return [
    part(0, 1),
    part(1, 2),
    part(2, 5, true),
    part(5, 6),
    part(6, rows.length - 1, true),
    part(rows.length - 1, rows.length)
  ]
}

// Keep a closing relation on the native row of its protected opening.
function splitAcrossProtectedRelation(
  unit: PdfTranslationSource['units'][number] | undefined,
  prefix: PdfTranslationSource['units'][number],
  pages: readonly PdfLayoutPage[]
): readonly PdfTranslationSource['units'][number][] | undefined {
  if (
    !unit ||
    unit.sourceOnly ||
    unit.preserve ||
    unit.figure ||
    unit.referenceBoundary ||
    unit.fragments.length !== 2 ||
    !unit.source.startsWith(') ') ||
    !prefix.sourceOnly ||
    prefix.preserve !== 'formula' ||
    prefix.fragments.length !== 1 ||
    !/^\(for [a-z]$/u.test(prefix.source)
  )
    return
  const [head, tail] = unit.fragments,
    [protectedRow] = prefix.fragments,
    page = pages[head.pageNumber - 1]
  if (
    page?.rotation !== 0 ||
    head.pageNumber !== tail.pageNumber ||
    tail.pageNumber !== protectedRow.pageNumber ||
    tail.items.length !== 1 ||
    protectedRow.items.length !== 2
  )
    return
  const [close] = tail.items,
    [lead, variable] = protectedRow.items,
    preceding = head.items.at(-1),
    [before, opening, symbol, after] = [
      preceding?.index ?? -1,
      lead.index,
      variable.index,
      close.index
    ].map((index) => page.items[index])
  if (
    !before ||
    !opening ||
    !symbol ||
    !after ||
    !/^=\s*[1-9]\d?\) and [A-Za-z]/u.test(close.text) ||
    !unit.source.endsWith(' ' + close.text.trim()) ||
    opening.str !== '(for' ||
    symbol.str !== prefix.source.at(-1) ||
    !opening.fontName ||
    [before, after].some((item) => item.fontName !== opening.fontName) ||
    symbol.fontName === opening.fontName ||
    !symbol.fontName ||
    ![before, opening, symbol, after].every(
      (item) =>
        item.dir === 'ltr' &&
        item.transform[0] > 0 &&
        item.transform[1] === 0 &&
        item.transform[2] === 0 &&
        item.transform[3] > 0 &&
        Math.abs(item.height - opening.height) < opening.height * 0.05
    ) ||
    !before.hasEOL ||
    opening.hasEOL ||
    symbol.hasEOL ||
    (!after.hasEOL &&
      !(!page.items[close.index + 1]?.str.trim() && page.items[close.index + 1]?.hasEOL)) ||
    Math.abs(symbol.transform[5] - opening.transform[5]) >= opening.height * 0.05 ||
    Math.abs(after.transform[5] - opening.transform[5]) >= opening.height * 0.05 ||
    before.transform[5] - opening.transform[5] <= opening.height ||
    before.transform[5] - opening.transform[5] >= opening.height * 1.5 ||
    after.transform[4] - symbol.transform[4] - symbol.width < 0 ||
    after.transform[4] - symbol.transform[4] - symbol.width >= opening.height * 0.5 ||
    ![preceding!.index, lead.index, variable.index, close.index].every(
      (index, position, all) =>
        !position ||
        (index > all[position - 1] &&
          page.items.slice(all[position - 1] + 1, index).every((item) => !item.str.trim()))
    )
  )
    return
  const source = close.text.trim()
  return [
    {
      ...unit,
      source: unit.source.slice(0, -(source.length + 1)),
      fragments: [head]
    },
    prefix,
    { ...unit, id: unit.id + '-relation-tail', source, fragments: [tail] }
  ]
}

// A wrapped body word can follow an independently preserved inline formula.
function joinInlineFormulaWordWrap(
  units: PdfTranslationSource['units'],
  pages: PdfLayoutPage[]
): PdfTranslationSource['units'] {
  type Unit = PdfTranslationSource['units'][number]
  const joinedUnits: Unit[] = []
  for (const [index, tail] of units.entries()) {
    const head = joinedUnits.at(-1)
    const formula = units[index - 2]
    const lead = units[index - 3]
    if (
      !head ||
      formula?.preserve !== 'formula' ||
      !formula.sourceOnly ||
      !lead ||
      [head, tail, lead].some(
        (unit) => unit.sourceOnly || unit.preserve || unit.figure || unit.referenceBoundary
      ) ||
      [head, tail, formula, lead].some(
        (unit) => unit.fragments.length !== 1 || unit.fragments[0].unclippedRect
      )
    ) {
      joinedUnits.push(tail)
      continue
    }
    const [upper, lower, math, prefix] = [head, tail, formula, lead].map(
      (unit) => unit.fragments[0]
    )
    const page = pages[upper.pageNumber - 1]
    const [left] = upper.items
    const [right] = lower.items
    const leftWord = /\b([a-z]{3,})-$/u.exec(head.source)?.[1]
    const rightWord = /^([a-z]{3,})\s+[a-z]/u.exec(tail.source)?.[1]
    if (
      page?.rotation !== 0 ||
      [lower, math, prefix].some((fragment) => fragment.pageNumber !== upper.pageNumber) ||
      upper.items.length !== 1 ||
      lower.items.length !== 1 ||
      !math.items.length ||
      !prefix.items.length ||
      !leftWord ||
      !rightWord ||
      head.source.split(/\s+/u).length < 6 ||
      tail.source.split(/\s+/u).length < 4 ||
      left.index + 1 !== right.index ||
      left.text !== head.source ||
      right.text !== tail.source
    ) {
      joinedUnits.push(tail)
      continue
    }
    const [a, b, start, lastMath] = [
      left.index,
      right.index,
      prefix.items[0].index,
      math.items.at(-1)!.index
    ].map((nativeIndex) => page.items[nativeIndex])
    const closes = page.items
      .slice(math.items.at(-1)!.index + 1, left.index)
      .filter((item) => item.str.trim())
    const close = closes[0]
    if (!a || !b || !start || !lastMath || closes.length !== 1 || !close) {
      joinedUnits.push(tail)
      continue
    }
    const em = a.height
    const x = (item: PdfLayoutTextItem): number => item.transform[4]
    const y = (item: PdfLayoutTextItem): number => item.transform[5]
    if (
      a.str !== left.text ||
      b.str !== right.text ||
      !a.hasEOL ||
      close.str !== ')' ||
      ![a, b, start, lastMath, close].every(
        (item) =>
          item.dir === 'ltr' &&
          !!item.fontName &&
          item.fontVertical === false &&
          item.width > 0 &&
          item.height === em &&
          [item.width, ...item.transform].every(Number.isFinite) &&
          item.transform[0] === em &&
          item.transform[1] === 0 &&
          item.transform[2] === 0 &&
          item.transform[3] === em
      ) ||
      [b, start].some((item) => item.fontName !== a.fontName) ||
      close.fontName === a.fontName ||
      Math.abs(x(start) - x(b)) >= em * 0.08 ||
      Math.abs(y(start) - y(a)) >= em * 0.05 ||
      Math.abs(y(lastMath) - y(a)) >= em * 0.05 ||
      y(a) - y(b) <= em ||
      y(a) - y(b) >= em * 1.5 ||
      y(close) - y(a) <= em * 0.6 ||
      y(close) - y(a) >= em ||
      x(a) - x(b) < em * 3 ||
      x(a) >= x(b) + b.width ||
      x(a) - x(close) - close.width < 0 ||
      x(a) - x(close) - close.width >= em * 0.5
    ) {
      joinedUnits.push(tail)
      continue
    }
    const word = leftWord + rightWord
    const printedHyphen = leftWord + '-' + rightWord
    const words = new Set(
      page.items.flatMap((item) => item.str.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/gu) ?? [])
    )
    // An intact -ic adjective can witness the corresponding -ical form.
    const plainSpelling = words.has(word) || (word.endsWith('ical') && words.has(word.slice(0, -2)))
    const hyphenatedSpelling = words.has(printedHyphen)
    if (!plainSpelling && !hyphenatedSpelling) {
      joinedUnits.push(tail)
      continue
    }
    joinedUnits[joinedUnits.length - 1] = {
      ...head,
      source: (hyphenatedSpelling ? head.source : head.source.slice(0, -1)) + tail.source,
      fragments: [upper, lower]
    }
  }
  return joinedUnits
}

// A numbered display can be followed by an inline definition whose closing delimiter owns prose.
function joinPrintedFunctionDefinitions(
  units: PdfTranslationSource['units'],
  pages: readonly PdfLayoutPage[]
): PdfTranslationSource['units'] {
  type Unit = PdfTranslationSource['units'][number]
  const result: Unit[] = []
  for (const tail of units) {
    const head = result.at(-1)
    result.push(tail)
    const [prefix] = head?.fragments ?? []
    const [suffix, ...remaining] = tail.fragments
    if (
      !head ||
      head.fragments.length !== 1 ||
      !prefix ||
      !suffix ||
      prefix.pageNumber !== suffix.pageNumber ||
      prefix.unclippedRect ||
      suffix.unclippedRect ||
      [head, tail].some(
        (unit) => unit.sourceOnly || unit.preserve || unit.figure || unit.referenceBoundary
      ) ||
      !/^where [A-Z][a-z]?\([\p{Script=Greek}]$/u.test(head.source) ||
      !/^\) represents (?:[\p{L}]{2,}\s+){4,}/u.test(tail.source)
    ) {
      continue
    }
    const page = pages[prefix.pageNumber - 1]
    const claims = [...prefix.items, ...suffix.items]
    const native = claims.map(({ index }) => page?.items[index])
    const [where, name] = native
    const [opening, operand, closing] = native.slice(prefix.items.length - 2)
    const script = prefix.items.length === 5 ? native[2] : undefined
    if (
      page?.page !== prefix.pageNumber ||
      page.rotation ||
      !where ||
      !name ||
      !opening ||
      !operand ||
      !closing ||
      where.str !== 'where' ||
      !/^[A-Z]$/u.test(name.str) ||
      opening.str !== '(' ||
      !/^\p{Script=Greek}$/u.test(operand.str) ||
      opening.fontName !== where.fontName ||
      closing.fontName !== where.fontName ||
      name.fontName !== operand.fontName ||
      name.fontName === where.fontName ||
      (prefix.items.length !== 4 && prefix.items.length !== 5) ||
      !native.every((item, at) => {
        const claim = claims[at]
        const prior = claims[at - 1]
        return (
          item &&
          item.str === claim.text &&
          item.dir === 'ltr' &&
          item.fontName &&
          item.fontVertical === false &&
          item.transform.every(Number.isFinite) &&
          item.width > 0 &&
          item.transform[0] > 0 &&
          item.transform[3] > 0 &&
          item.transform[1] === 0 &&
          item.transform[2] === 0 &&
          (at === 0 ||
            (claim.index > prior.index &&
              page.items.slice(prior.index + 1, claim.index).every((run) => !run.str.trim()) &&
              !native[at - 1]?.hasEOL))
        )
      })
    ) {
      continue
    }
    const em = where.height
    const baseline = where.transform[5]
    const index = claims[0].index
    const tagIndex = page.items.slice(0, index).findLastIndex((item) => item.str.trim())
    const tag = page.items[tagIndex]
    if (
      !tag?.hasEOL ||
      !/^\([1-9]\d?\)$/u.test(tag.str) ||
      tag.fontName !== where.fontName ||
      tag.transform[5] - baseline < em * 1.5 ||
      tag.transform[5] - baseline > em * 3 ||
      tag.transform[4] < page.width * 0.8 ||
      !units.some(
        (unit) =>
          unit.sourceOnly &&
          unit.preserve === 'formula' &&
          unit.fragments.some(
            (fragment) =>
              fragment.pageNumber === page.page &&
              fragment.items.some((item) => item.index === tagIndex && item.text === tag.str)
          )
      ) ||
      (script &&
        (!/^[a-z]$/u.test(script.str) ||
          script.height < em * 0.6 ||
          script.height > em * 0.8 ||
          baseline - script.transform[5] < em * 0.1 ||
          baseline - script.transform[5] > em * 0.2)) ||
      native.some((item, at) => {
        if (!item) return true
        const prior = native[at - 1]
        return (
          (item !== script &&
            (Math.abs(item.height - em) >= em * 0.05 ||
              Math.abs(item.transform[5] - baseline) >= em * 0.05)) ||
          (prior &&
            (item.transform[4] - prior.transform[4] - prior.width < -em * 0.05 ||
              item.transform[4] - prior.transform[4] - prior.width > em * 0.6))
        )
      })
    ) {
      continue
    }
    const first = prefix.rect
    const second = suffix.rect
    // Join only the first row. Each later native fragment keeps its original bounds.
    const rect = {
      x: first.x,
      y: Math.min(first.y, second.y),
      width: second.x + second.width - first.x,
      height:
        Math.max(first.y + first.height, second.y + second.height) - Math.min(first.y, second.y)
    }
    result.pop()
    result[result.length - 1] = {
      ...head,
      source: head.source + tail.source,
      fragments: [{ ...prefix, rect, items: claims }, ...remaining]
    }
  }
  return result
}

// A formula at the start of a row can leave a wrapped sentence opener in its prose neighbor.
function joinFormulaAdjacentSentenceWraps(
  units: PdfTranslationSource['units'],
  pages: readonly PdfLayoutPage[]
): PdfTranslationSource['units'] {
  const joined: PdfTranslationSource['units'][number][] = []
  for (const [index, tail] of units.entries()) {
    const head = units[index - 1]
    const formula = units[index - 2]
    if (
      !head?.source.endsWith('. In') ||
      !/^particular, .+\.$/u.test(tail.source) ||
      formula?.preserve !== 'formula' ||
      !formula.sourceOnly ||
      !/:=.+\.$/u.test(formula.source) ||
      [head, tail].some(
        (unit) => unit.sourceOnly || unit.preserve || unit.figure || unit.referenceBoundary
      ) ||
      [formula, head, tail].some(
        (unit) => unit.fragments.length !== 1 || unit.fragments[0].unclippedRect
      )
    ) {
      joined.push(tail)
      continue
    }

    const [prefix, upper, lower] = [formula, head, tail].map((unit) => unit.fragments[0])
    const page = pages[upper.pageNumber - 1]
    const [formulaStart, formulaEnd, bodyStart, opener, continuation, end] = [
      prefix.items[0],
      prefix.items.at(-1),
      upper.items[0],
      upper.items.at(-1),
      lower.items[0],
      lower.items.at(-1)
    ].map((claim) => claim && page?.items[claim.index])
    if (
      page?.page !== upper.pageNumber ||
      page.rotation ||
      [prefix, lower].some((fragment) => fragment.pageNumber !== page.page) ||
      !formulaStart ||
      !formulaEnd ||
      !bodyStart ||
      !opener ||
      !continuation ||
      !end ||
      opener.str !== 'In' ||
      continuation.str !== 'particular,' ||
      !opener.hasEOL ||
      !end.hasEOL
    ) {
      joined.push(tail)
      continue
    }

    const em = bodyStart.height
    const x = (item: PdfLayoutTextItem): number => item.transform[4]
    const y = (item: PdfLayoutTextItem): number => item.transform[5]
    const near = (distance: number): boolean => Math.abs(distance) < em * 0.06
    const rowPitch = y(opener) - y(continuation)
    const formulaGap = x(bodyStart) - x(formulaEnd) - formulaEnd.width
    const claims = [...prefix.items, ...upper.items, ...lower.items]
    const first = claims[0].index
    const native = page.items
      .slice(first, claims.at(-1)!.index + 1)
      .flatMap((item, offset) =>
        item.str.trim() ? [{ index: first + offset, text: item.str }] : []
      )
    if (
      !bodyStart.fontName ||
      ![formulaStart, formulaEnd, bodyStart, opener, continuation, end].every(
        (item) =>
          item.dir === 'ltr' &&
          item.fontName === bodyStart.fontName &&
          item.fontVertical === false &&
          item.height === em &&
          item.width > 0 &&
          item.transform.every(Number.isFinite) &&
          item.transform[0] === em &&
          item.transform[1] === 0 &&
          item.transform[2] === 0 &&
          item.transform[3] === em
      ) ||
      !near(y(formulaStart) - y(opener)) ||
      !near(y(formulaEnd) - y(opener)) ||
      !near(y(bodyStart) - y(opener)) ||
      !near(y(continuation) - y(end)) ||
      !near(x(continuation) - x(formulaStart)) ||
      rowPitch < em * 1.05 ||
      rowPitch > em * 1.35 ||
      formulaGap < em * 0.4 ||
      formulaGap > em ||
      x(opener) + opener.width - x(formulaStart) < page.width * 0.6 ||
      x(end) + end.width > x(bodyStart) + (x(opener) - x(bodyStart)) * 0.5 ||
      native.length !== claims.length ||
      native.some(({ index: at, text }, n) => at !== claims[n].index || text !== claims[n].text)
    ) {
      joined.push(tail)
      continue
    }
    joined[joined.length - 1] = {
      ...head,
      source: head.source + ' ' + tail.source,
      fragments: [upper, lower]
    }
  }
  return joined
}

// A wrapped induction premise can precede an independently owned stacked expression.
function joinWrappedInductionPremises(
  units: readonly PdfTranslationSource['units'][number][],
  pages: readonly PdfLayoutPage[]
): PdfTranslationSource['units'] {
  const joined: PdfTranslationSource['units'][number][] = []
  for (let index = 0; index < units.length; index++) {
    const [head, radical, premise, connective, fraction] = units.slice(index, index + 5)
    if (
      !/\bholds? true$/u.test(head.source) ||
      radical?.source !== '√' ||
      !/^for [a-z] − \d{1,2}$/u.test(premise?.source ?? '') ||
      connective?.source !== ', that is' ||
      ![radical, fraction].every((unit) => unit?.sourceOnly && unit.preserve === 'formula') ||
      [head, premise, connective].some(
        (unit) => unit.sourceOnly || unit.preserve || unit.figure || unit.referenceBoundary
      ) ||
      [head, radical, premise, connective, fraction].some(
        (unit) => unit.fragments.length !== 1 || unit.fragments[0].unclippedRect
      )
    ) {
      joined.push(head)
      continue
    }

    const [upper, root, lower, comma, math] = [head, radical, premise, connective, fraction].map(
      (unit) => unit.fragments[0]
    )
    const page = pages[upper.pageNumber - 1]
    if (
      page?.page !== upper.pageNumber ||
      page.rotation ||
      [root, lower, comma, math].some((fragment) => fragment.pageNumber !== upper.pageNumber) ||
      lower.items.length !== 4 ||
      comma.items.length !== 1 ||
      root.items.length !== 1
    ) {
      joined.push(head)
      continue
    }

    const claims = [...upper.items, ...lower.items, ...comma.items]
    const native = claims.map(({ index }) => page.items[index])
    const [begin, finish, start, punctuation, expression, sign] = [
      upper.items[0],
      upper.items.at(-1),
      lower.items[0],
      comma.items[0],
      math.items[0],
      root.items[0]
    ].map((claim) => claim && page.items[claim.index])
    if (!begin || !finish || !start || !punctuation || !expression || !sign) {
      joined.push(head)
      continue
    }
    const em = finish.height
    const x = (item: PdfLayoutTextItem): number => item.transform[4]
    const y = (item: PdfLayoutTextItem): number => item.transform[5]
    const near = (distance: number): boolean => Math.abs(distance) < em * 0.06
    const pitch = y(finish) - y(start)
    const first = upper.items[0].index
    const read = page.items
      .slice(first, comma.items[0].index + 1)
      .flatMap((item, offset) =>
        item.str.trim() ? [{ index: first + offset, text: item.str }] : []
      )
    if (
      !finish.fontName ||
      !finish.hasEOL ||
      start.str !== 'for' ||
      start.fontName !== finish.fontName ||
      punctuation.str !== connective.source ||
      punctuation.fontName !== finish.fontName ||
      !native.every(
        (item, at) =>
          item?.str === claims[at].text &&
          item.dir === 'ltr' &&
          item.fontVertical === false &&
          item.height === em &&
          item.width > 0 &&
          item.transform.every(Number.isFinite) &&
          item.transform[0] === em &&
          item.transform[1] === 0 &&
          item.transform[2] === 0 &&
          item.transform[3] === em &&
          near(y(item) - y(at < upper.items.length ? finish : start))
      ) ||
      !near(x(begin) - x(start)) ||
      pitch < em * 1.25 ||
      pitch > em * 1.55 ||
      !near(lower.rect.y * page.height - comma.rect.y * page.height) ||
      !near((comma.rect.x - lower.rect.x - lower.rect.width) * page.width) ||
      math.items[0].index <= comma.items[0].index ||
      root.items[0].index <= math.items[0].index ||
      x(expression) - x(punctuation) - punctuation.width < 0 ||
      x(expression) - x(punctuation) - punctuation.width > em * 0.6 ||
      y(expression) - y(start) < em * 0.2 ||
      y(expression) - y(start) > em * 0.6 ||
      sign.str !== '√' ||
      x(sign) <= x(expression) ||
      read.length !== claims.length ||
      read.some((item, at) => item.index !== claims[at].index || item.text !== claims[at].text)
    ) {
      joined.push(head)
      continue
    }

    joined.push(
      {
        ...head,
        source: head.source + ' ' + premise.source + connective.source,
        fragments: [
          upper,
          {
            ...lower,
            rect: { ...lower.rect, width: comma.rect.x + comma.rect.width - lower.rect.x },
            items: [...lower.items, ...comma.items]
          }
        ]
      },
      radical
    )
    index += 3
  }
  return joined
}

// A page can end after the short last row of a comparison phrase.
function joinTerminalComparisonWraps(
  units: PdfTranslationSource['units'],
  pages: readonly PdfLayoutPage[]
): PdfTranslationSource['units'] {
  const joined: PdfTranslationSource['units'][number][] = []
  for (const [index, tail] of units.entries()) {
    const head = units[index - 1]
    if (
      tail.source === 'to' &&
      head?.source.endsWith(' similar') &&
      [head, tail].every(
        (unit) =>
          !unit.sourceOnly &&
          !unit.preserve &&
          !unit.figure &&
          !unit.referenceBoundary &&
          unit.fragments.length === 1 &&
          !unit.fragments[0].unclippedRect
      )
    ) {
      const [upper] = head.fragments
      const [lower] = tail.fragments
      const page = pages[upper.pageNumber - 1]
      const last = upper.items.at(-1)
      const [claim] = lower.items
      const previous = last && page?.items[last.index]
      const next = claim && page?.items[claim.index]
      if (
        page &&
        page.page === upper.pageNumber &&
        lower.pageNumber === upper.pageNumber &&
        !page.rotation &&
        page.page < pages.length &&
        previous?.str === last?.text &&
        previous?.str.endsWith(' similar') &&
        previous.hasEOL &&
        next?.str === claim?.text &&
        next?.str === 'to' &&
        last &&
        claim &&
        claim.index === last.index + 1 &&
        lower.items.length === 1 &&
        page.items.findLastIndex((item) => item.str.trim()) === claim.index &&
        previous.fontName &&
        previous.fontName === next.fontName &&
        [previous, next].every(
          (item) =>
            item.dir === 'ltr' &&
            item.fontVertical === false &&
            item.height === next.height &&
            item.width > 0 &&
            item.transform[0] === next.height &&
            item.transform[3] === next.height &&
            item.transform[1] === 0 &&
            item.transform[2] === 0
        ) &&
        Math.abs(previous.transform[4] - next.transform[4]) < next.height * 0.05 &&
        previous.transform[5] - next.transform[5] > next.height &&
        previous.transform[5] - next.transform[5] < next.height * 1.3 &&
        previous.width > next.height * 12 &&
        next.width < next.height * 1.1 &&
        lower.rect.y > 0.85 &&
        Math.abs(upper.rect.y + upper.rect.height - lower.rect.y) < 0.002 &&
        Math.abs(lower.rect.x - upper.rect.x) < 0.001
      ) {
        joined[joined.length - 1] = {
          ...head,
          source: head.source + ' ' + tail.source,
          fragments: [
            {
              ...upper,
              rect: { ...upper.rect, height: lower.rect.y + lower.rect.height - upper.rect.y },
              items: [...upper.items, ...lower.items]
            }
          ]
        }
        continue
      }
    }
    joined.push(tail)
  }
  return joined
}

// Repeated address text can bridge two otherwise independent author columns.
function separateRepeatedAffiliationAddresses(
  units: readonly PdfTranslationSource['units'][number][],
  page: PdfLayoutPage
): readonly PdfTranslationSource['units'][number][] {
  const [, authors, left, leftAddress, middle, right, date] = units
  if (!page || page.rotation || !date || !/^[A-Z][a-z]+ [1-9]\d?, \d{4}$/u.test(date.source))
    return units
  const [top, bottom] = middle.fragments
  const [rightTop] = right.fragments
  const pair = bottom?.items
  if (
    middle.fragments.length !== 2 ||
    right.fragments.length !== 1 ||
    [left, leftAddress, date].some((unit) => unit.fragments.length !== 1) ||
    [left, leftAddress, middle, right].some(
      (unit) => unit.sourceOnly || unit.preserve || unit.figure || unit.referenceBoundary
    ) ||
    !top ||
    !rightTop ||
    top.items.length !== 1 ||
    rightTop.items.length !== 1 ||
    pair?.length !== 2 ||
    pair[0].text !== pair[1].text ||
    top.items[0].text !== rightTop.items[0].text ||
    right.source !== rightTop.items[0].text ||
    middle.source !== `${right.source} ${pair[0].text} ${pair[1].text}` ||
    !/\b(?:University|Institute|College)\b/u.test(left.source) ||
    !/\b(?:University|Institute|College)\b/u.test(right.source) ||
    ![leftAddress.source, pair[0].text].every((s) =>
      /^[\p{Lu}][\p{L} .'-]+, [A-Z]{2}, \d{5}$/u.test(s)
    ) ||
    !authors ||
    authors.fragments.length !== 1 ||
    authors.fragments[0].pageNumber !== 1 ||
    date.fragments[0].pageNumber !== 1 ||
    !['∗', '†', '‡'].every((mark) => authors.fragments[0].items.some(({ text }) => text === mark))
  )
    return units
  const rows = [left.fragments[0], top, rightTop, leftAddress.fragments[0], bottom]
  if (
    rows.some(({ pageNumber }) => pageNumber !== 1) ||
    rows.slice(0, -1).some(({ items }) => items.length !== 1)
  )
    return units
  const claims = rows.flatMap((fragment) => fragment.items)
  const items = claims.map(({ index }) => page.items[index])
  if (
    items.some(
      (item, i) =>
        !item ||
        item.str !== claims[i].text ||
        item.dir !== 'ltr' ||
        item.transform[0] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        item.transform[3] <= 0 ||
        !item.transform.every(Number.isFinite) ||
        item.width <= 0
    )
  )
    return units
  const [first, , , firstAddress] = items
  const em = first.height,
    pitch = first.transform[5] - firstAddress.transform[5]
  const center = (item: PdfLayoutTextItem): number => item.transform[4] + item.width / 2
  const beforeDate = page.items[date.fragments[0].items[0].index]
  if (
    em <= 0 ||
    pitch < em * 1.4 ||
    pitch > em * 2 ||
    !beforeDate ||
    beforeDate.transform[5] >= firstAddress.transform[5] - em * 2 ||
    items.some(
      (item, i) =>
        item.fontName !== first.fontName ||
        item.height !== em ||
        Math.abs(item.transform[5] - (i < 3 ? first : firstAddress).transform[5]) > em * 0.04 ||
        (i > 0 &&
          i !== 3 &&
          item.transform[4] - items[i - 1].transform[4] - items[i - 1].width < em * 3) ||
        (i >= 3 && Math.abs(center(item) - center(items[i - 3])) > em * 0.04)
    ) ||
    page.items.slice(claims[0].index, claims.at(-1)!.index + 1).filter((item) => item.str.trim())
      .length !== items.length
  )
    return units
  const separated = units.slice()
  for (const [column, owner] of [middle, right].entries()) {
    const item = items[column + 4]
    const address = pair[column]
    separated[column + 4] = {
      ...owner,
      source: `${rightTop.items[0].text} ${address.text}`,
      fragments: [
        owner.fragments[0],
        {
          ...bottom,
          rect: {
            ...bottom.rect,
            x: item.transform[4] / page.width,
            width: item.width / page.width
          },
          items: [address]
        }
      ]
    }
  }
  return separated
}

// Two wrapped prose rows can each be separated by a native stacked coefficient.
function restoreInlineCoefficientReadingOrder(
  units: readonly PdfTranslationSource['units'][number][],
  pages: readonly PdfLayoutPage[]
): readonly PdfTranslationSource['units'][number][] {
  let corrected: PdfTranslationSource['units'][number][] | undefined
  for (let index = 0; index + 7 < units.length; index++) {
    const [left, coefficient, right, open, close, ratios, factor, end] = units.slice(
      index,
      index + 8
    )
    if (
      !/\bterm is exactly a trivial upper bound$/u.test(left.source) ||
      !/^, while the .+ have \(here one may assume that both [a-z] and [a-z] are$/u.test(
        right.source
      ) ||
      !/^even\.\) One only need[s]? to prove that$/u.test(end.source) ||
      [left, right, end].some((unit) => unit.sourceOnly || unit.preserve || unit.figure) ||
      [coefficient, open, close, ratios].some((unit) => unit.preserve !== 'formula') ||
      !/^[a-z]$/u.test(factor.source) ||
      left.fragments.length !== 2 ||
      right.fragments.length !== 2 ||
      [coefficient, open, close, ratios, factor, end].some((unit) => unit.fragments.length !== 1)
    )
      continue

    const [lead, lowerLead] = left.fragments
    const [upperTail, lowerTail] = right.fragments
    const [closing] = end.fragments
    const page = pages[lead.pageNumber - 1]
    if (
      !page ||
      page.rotation ||
      units
        .slice(index, index + 8)
        .some((unit) => unit.fragments.some((fragment) => fragment.pageNumber !== page.page))
    )
      continue
    const [openingRun, lastLead, bound, connector, assumption, lastAssumption, finish] = [
      lead.items[0],
      lead.items.at(-1),
      lowerLead.items[0],
      upperTail.items[0],
      lowerTail.items[0],
      lowerTail.items.at(-1),
      closing.items[0]
    ].map((item) => item && page.items[item.index])
    if (
      !openingRun ||
      !lastLead ||
      !bound ||
      !connector ||
      !assumption ||
      !lastAssumption ||
      !finish
    )
      continue
    const em = openingRun.height
    const y = (item: PdfLayoutTextItem): number => item.transform[5]
    const x = (item: PdfLayoutTextItem): number => item.transform[4]
    const rightEdge = (item: PdfLayoutTextItem): number => x(item) + item.width
    const near = (value: number): boolean => Math.abs(value) < em * 0.1
    const pitch = y(openingRun) - y(bound)
    if (
      lowerLead.items.length !== 1 ||
      upperTail.items.length !== 1 ||
      closing.items.length !== 1 ||
      bound.str !== 'a trivial upper bound' ||
      !/^\(here one may assume that both$/u.test(assumption.str) ||
      !connector.hasEOL ||
      !lastAssumption.hasEOL ||
      pitch < em * 1.25 ||
      pitch > em * 1.5 ||
      !near(y(openingRun) - y(connector)) ||
      !near(y(bound) - y(assumption)) ||
      !near(y(bound) - y(finish) - pitch) ||
      !near(x(bound) - x(finish)) ||
      !near(rightEdge(connector) - rightEdge(lastAssumption)) ||
      [lastLead, bound, connector, assumption, lastAssumption, finish].some(
        (item) => item.fontName !== openingRun.fontName || !near(item.height - em)
      )
    )
      continue
    const nativeClaims = [
      lead,
      coefficient.fragments[0],
      upperTail,
      lowerLead,
      factor.fragments[0],
      open.fragments[0],
      ratios.fragments[0],
      close.fragments[0],
      lowerTail,
      closing
    ]
      .flatMap((fragment) => fragment.items)
      .sort((a, b) => a.index - b.index)
    const first = lead.items[0].index
    const last = closing.items[0].index
    const visible = page.items
      .slice(first, last + 1)
      .flatMap((item, offset) =>
        item.str.trim() ? [{ index: first + offset, text: item.str }] : []
      )
    if (
      visible.length !== nativeClaims.length ||
      visible.some(
        (item, i) => item.index !== nativeClaims[i].index || item.text !== nativeClaims[i].text
      )
    )
      continue
    const firstOpen = coefficient.fragments[0].items.find(({ text }) => text === '\0')
    const firstClose = coefficient.fragments[0].items.find(({ text }) => text === '\u0001')
    if (
      !firstOpen ||
      !firstClose ||
      open.source !== '\0' ||
      close.source !== '\u0001' ||
      ![open, close].every(
        (bracket, i) =>
          page.items[bracket.fragments[0].items[0].index].fontName ===
          page.items[[firstOpen, firstClose][i].index].fontName
      )
    )
      continue
    const assumptionOffset = right.source.indexOf(' ' + assumption.str)
    if (assumptionOffset < 0) continue
    corrected ??= units.slice()
    corrected[index] = {
      ...left,
      source: left.source.slice(0, -bound.str.length).trimEnd(),
      fragments: [lead]
    }
    corrected[index + 2] = {
      ...right,
      source: right.source.slice(0, assumptionOffset) + ' ' + bound.str,
      fragments: [upperTail, lowerLead]
    }
    corrected[index + 7] = {
      ...end,
      source: right.source.slice(assumptionOffset + 1) + ' ' + end.source,
      fragments: [lowerTail, closing]
    }
    return corrected
  }
  return units
}

// A split conditional after a protected formula can lose its governing negation.
function retainFragmentedMathCondition(
  units: readonly PdfTranslationSource['units'][number][],
  page: PdfLayoutPage
): readonly PdfTranslationSource['units'][number][] {
  if (page.rotation !== 0) return units
  const retained = new Set<string>()
  for (let i = 0; i + 4 < units.length; i++) {
    const [before, start, condition, constant, end] = units.slice(i, i + 5)
    if (
      !before.sourceOnly ||
      before.preserve !== 'formula' ||
      !constant.sourceOnly ||
      constant.preserve !== 'formula' ||
      !/\p{L}\(\p{L}$/u.test(before.source) ||
      !/^\)\. This$/u.test(start.source) ||
      !/^\p{Ll}{2,16} does not (?:\p{Ll}+ ){2,6}if (?:\p{Ll}+ ){1,5}constant$/u.test(
        condition.source
      ) ||
      !/^by any number (?:smaller|larger) than .+\.$/u.test(end.source) ||
      [start, condition, end].some((unit) => unit.sourceOnly || unit.preserve || unit.figure) ||
      [before, start, condition, constant, end].some(
        (unit) => unit.fragments.length !== 1 || unit.fragments[0].pageNumber !== 1
      )
    )
      continue
    const fragments = [before, start, condition, constant, end].map((unit) => unit.fragments[0])
    const native = fragments.map((fragment) => fragment.items.map(({ index }) => page.items[index]))
    const [tail, [head], [body], fraction, [close]] = native
    const preceding = tail.at(-1)
    if (
      !preceding ||
      !head ||
      !body ||
      !close ||
      native[1].length !== 1 ||
      native[2].length !== 1 ||
      fraction.length < 5 ||
      !head.hasEOL ||
      !head.fontName ||
      [head, body, close].some(
        (item) =>
          item.dir !== 'ltr' ||
          item.fontName !== head.fontName ||
          item.height !== head.height ||
          item.transform[0] <= 0 ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          item.transform[3] <= 0
      )
    )
      continue
    const em = head.height
    const [hx, hy] = head.transform.slice(4)
    const [bx, by] = body.transform.slice(4)
    const [cx, cy] = close.transform.slice(4)
    if (
      Math.abs(preceding.transform[5] - hy) > em * 0.05 ||
      Math.abs(preceding.transform[4] + preceding.width - hx) > em * 0.15 ||
      hy - by <= em ||
      hy - by >= em * 1.5 ||
      hx - bx < em * 15 ||
      Math.abs(cy - by) > em * 0.05 ||
      cx <= bx + body.width ||
      !fraction.some((item) => item.transform[5] > by + em * 0.2) ||
      !fraction.some((item) => item.transform[5] < by - em * 0.2) ||
      fraction.some(
        (item) => item.transform[4] < bx + body.width || item.transform[4] + item.width > cx
      ) ||
      fragments.some((fragment, n) => {
        if (n === 0) return false
        const last = fragments[n - 1].items.at(-1)!.index
        const first = fragment.items[0].index
        return first <= last || page.items.slice(last + 1, first).some((item) => item.str.trim())
      })
    )
      continue
    for (const unit of [start, condition, end]) retained.add(unit.id)
  }
  return retained.size
    ? units.map((unit) =>
        retained.has(unit.id) ? { ...unit, sourceOnly: true, preserve: 'literal' } : unit
      )
    : units
}

type TextStyle = { vertical?: boolean; ascent?: number; descent?: number }

// Text-run navigation bounds, not glyph outlines or regions safe to paint over.
// PDF.js TextLayer uses a font-height box and falls back to ascent / 1+descent / 0.8.
function independentRect(
  item: PdfLayoutTextItem,
  page: PdfLayoutPage,
  style: TextStyle | undefined
): PdfTranslationSource['units'][number]['fragments'][number]['rect'] | undefined {
  if (item.dir !== 'ltr' || style?.vertical) return undefined
  const [a, b, c, d, x, y] = item.transform
  const advance = Math.hypot(a, b),
    font = Math.hypot(c, d)
  if (advance <= 0 || font <= 0 || item.width <= 0) return undefined
  const quarter = ((Math.round(Math.atan2(-b, a) / (Math.PI / 2)) % 4) + 4) % 4
  let [ux, uy] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1]
  ][quarter]
  if (Math.abs((a * c + b * d) / (advance * font)) > 0.0001 || a * d - b * c <= 0) return undefined
  if (Math.hypot(a / advance - ux, -b / advance - uy) > 0.0001) {
    // Arbitrary angles have no metric fallback: admit only an explicit native
    // horizontal font and finite ascent/descent. The result remains a separate
    // original-only navigation anchor, never a glyph-ink or repaint claim.
    if (
      style?.vertical !== false ||
      !Number.isFinite(style.ascent) ||
      !Number.isFinite(style.descent) ||
      style.ascent! <= style.descent! ||
      style.ascent! <= 0 ||
      style.ascent! > 1 ||
      style.descent! > 0 ||
      style.descent! < -1 ||
      !item.fontName ||
      item.height <= 0
    )
      return undefined
    ux = a / advance
    uy = -b / advance
  }
  const ascent = style?.ascent || (style?.descent ? 1 + style.descent : 0.8)
  const points = [
    [0, -ascent * font],
    [item.width, -ascent * font],
    [item.width, (1 - ascent) * font],
    [0, (1 - ascent) * font]
  ].map(([u, v]) => [x + ux * u - uy * v, page.height - y + uy * u + ux * v])
  const left = Math.min(...points.map(([x]) => x)),
    top = Math.min(...points.map(([, y]) => y))
  const rect = {
    x: left / page.width,
    y: top / page.height,
    width: (Math.max(...points.map(([x]) => x)) - left) / page.width,
    height: (Math.max(...points.map(([, y]) => y)) - top) / page.height
  }
  return Object.values(rect).every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= 1.000001 &&
    rect.y + rect.height <= 1.000001
    ? rect
    : undefined
}

type ExtractionInput = {
  document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'> &
    Partial<
      Pick<
        PDFDocumentProxy,
        'getData' | 'getMetadata' | 'getOutline' | 'getDestination' | 'getPageIndex'
      >
    >
  resourceRequestKey: string
  sourceIdentity?: Readonly<{
    sourceChecksum: string
    sourceSizeBytes: number
  }>
  nativeDocumentFactory?: typeof getDocument
  signal: AbortSignal
  onProgress?: (pagesRead: number) => void
}

/** Borrows the viewer PDF; disposes only its own auxiliary loading task. */
export async function extractPdfTranslationSource(
  input: ExtractionInput
): Promise<PdfTranslationExtraction> {
  const exclusions = createAuxiliaryNativeExclusionReader(input, readNativeFormClippedText)
  try {
    return await readPdfTranslationSource({
      ...input,
      nativeExclusions: exclusions
    })
  } finally {
    await exclusions.dispose()
  }
}

async function readPdfTranslationSource({
  document,
  resourceRequestKey,
  sourceIdentity,
  nativeDocumentFactory,
  signal,
  onProgress,
  nativeExclusions
}: ExtractionInput & {
  nativeExclusions: ReturnType<typeof createAuxiliaryNativeExclusionReader>
}): Promise<PdfTranslationExtraction> {
  signal.throwIfAborted()
  const fingerprint = document.fingerprints[0]
  if (!fingerprint || !Number.isInteger(document.numPages) || document.numPages < 1)
    throw new Error('Invalid PDF source identity')
  const terminalCaptions = createNativeTerminalCaptionReader({
    document,
    sourceIdentity,
    nativeDocumentFactory,
    signal
  })
  const taggedReferences = createNativeTaggedReferenceReader(document, signal)
  const algorithmCaptions = createNativeRuledAlgorithmCaptionReader({
    document,
    sourceIdentity,
    nativeDocumentFactory,
    signal
  })
  const occlusionProofs: NonNullable<Awaited<ReturnType<typeof readNativeOccludedText>>>[] = []
  const checkOcclusions = (): void => {
    if (
      occlusionProofs.length &&
      (document.fingerprints[0] !== fingerprint ||
        document.numPages !== navigationPageCount ||
        occlusionProofs.some((proof) => !proof.current()))
    )
      throw new Error('PDF source changed during occluded text verification')
  }
  const pages: PdfLayoutPage[] = []
  const captionTerminals: (() => boolean)[] = []
  const checkCaptionTerminals = (): void => {
    if (captionTerminals.some((current) => !current()))
      throw new Error('Native caption sources changed during extraction')
  }
  const onlineContexts: Parameters<typeof readNativeOnlineAppendixRestart>[0][] = []
  const scopedDisplays: {
    page: PDFPageProxy
    content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
    viewport: ReturnType<PDFPageProxy['getViewport']>
    pageNumber: number
  }[] = []
  const shortMathPages: typeof scopedDisplays = []
  const literalMathPages: typeof scopedDisplays = []
  const nativeMatrices: typeof scopedDisplays = []
  const nativeFunctions: typeof scopedDisplays = []
  const mathDiagrams: PdfMathDiagram[] = []
  const styles: Record<string, TextStyle>[] = []
  const pagesWithoutText: number[] = []
  const exclusions: PdfTranslationExtraction['coverage']['exclusions'][number][] = []
  const unreliableItems = new Set<string>()
  const unreliableMathItems = new Set<string>()
  const outlierNavigation = new Map<string, NonNullable<ReturnType<typeof independentRect>>>()
  const navigationPageCount = document.numPages
  const type3Navigation: NonNullable<Awaited<ReturnType<typeof readNativeType3Navigation>>>[] = []
  const navigationCurrent = (): boolean =>
    document.fingerprints[0] === fingerprint && document.numPages === navigationPageCount
  const checkType3Navigation = (): void => {
    if (type3Navigation.some((proof) => !proof.current()))
      throw new Error('PDF source changed during Type3 navigation verification')
  }
  const partialNavigation = new Map<
    string,
    NonNullable<ReturnType<typeof nativePartialNavigation>>
  >()
  const pageDiagnostics: NonNullable<
    PdfTranslationExtraction['coverage']['pageDiagnostics']
  >[number][] = []
  let textItemCount = 0
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    signal.throwIfAborted()
    const page = await document.getPage(pageNumber)
    signal.throwIfAborted()
    const viewport = page.getViewport({ scale: 1 })
    if (
      ![viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0) ||
      viewport.transform.length !== 6 ||
      !viewport.transform.every(Number.isFinite)
    )
      throw new Error('Invalid PDF page geometry')
    const content = await getPdfTranslationTextContent(
      page,
      (indexes, mathIndexes) => {
        for (const index of indexes) unreliableItems.add(`${pageNumber}:${index}`)
        for (const index of mathIndexes) unreliableMathItems.add(`${pageNumber}:${index}`)
      },
      (proved) => {
        if (proved)
          pageDiagnostics.push(Object.freeze({ pageNumber, reason: 'unreliable-font-unicode' }))
      }
    )
    signal.throwIfAborted()
    const occlusion = await readNativeOccludedText(page, content, viewport, () =>
      nativeExclusions.readNegativeExclusions({
        page,
        content,
        viewport,
        pageNumber,
        selected: new Set(
          content.items.flatMap((item, index) => ('str' in item && item.str.trim() ? [index] : []))
        )
      })
    )
    signal.throwIfAborted()
    if (occlusion) occlusionProofs.push(occlusion)
    let pageTextItems = 0
    const items = content.items.map((item, index) => {
      const empty = {
        str: '',
        width: 0,
        height: 0,
        dir: 'ltr',
        transform: [0, 0, 0, 0, 0, 0],
        hasEOL: 'hasEOL' in item ? item.hasEOL : undefined
      }
      if (!('str' in item) || !item.str) return empty
      const hasText = !!item.str.trim()
      if (hasText) {
        textItemCount++
        pageTextItems++
      }
      if (
        item.transform.length !== 6 ||
        ![...item.transform, item.width, item.height].every(Number.isFinite) ||
        item.width < 0 ||
        item.height < 0
      ) {
        if (hasText)
          exclusions.push({
            reason: 'invalid-geometry',
            items: [{ pageNumber, index, text: item.str }]
          })
        return empty
      }
      if (hasText && occlusion?.indexes.has(index)) {
        // Complete native ink is hidden by a proved fill or inherited Form clip.
        exclusions.push({
          reason: 'occluded-native-text',
          items: [{ pageNumber, index, text: item.str }]
        })
        return empty
      }
      // Express PDF coordinates in the reader's default viewport, including CropBox
      // offsets and UserUnit scaling. Grouping uses a bottom-up virtual PDF axis.
      const [a, b, c, d, x, y] = item.transform
      const partial =
        hasText && nativePartialNavigation(item, content.styles?.[item.fontName], viewport)
      if (partial) partialNavigation.set(`${pageNumber}:${index}`, partial)
      const [ma, mb, mc, md, mx, my] = viewport.transform
      const scale = Math.hypot(ma, mb)
      return {
        str: item.str,
        width: item.width * scale,
        height: item.height * scale,
        dir: item.dir,
        transform: [
          ma * a + mc * b,
          -(mb * a + md * b),
          ma * c + mc * d,
          -(mb * c + md * d),
          ma * x + mc * y + mx,
          viewport.height - (mb * x + md * y + my)
        ],
        fontName: item.fontName,
        fontFamily: content.styles?.[item.fontName]?.fontFamily,
        fontAscent: content.styles?.[item.fontName]?.ascent,
        fontDescent: content.styles?.[item.fontName]?.descent,
        fontVertical: content.styles?.[item.fontName]?.vertical,
        hasEOL: item.hasEOL
      }
    })
    const nativeReferenceEvidence = await readNativeReferenceEvidence(page, content)
    const nativeDisplayMathEvidence = await readNativeDisplayEquationEvidence(
      page,
      content,
      nativeReferenceEvidence
    )
    if (
      hasNativeEncodedRadicalMarker(content) ||
      (!nativeDisplayMathEvidence.complete &&
        (hasNativeDisplaySequence(content) ||
          hasNativeNestedIntegralMarker(content) ||
          hasNativeStackedFractionMarker(content)))
    )
      scopedDisplays.push({ page, content, viewport, pageNumber })
    if (hasNativeShortMathContinuation(content))
      shortMathPages.push({ page, content, viewport, pageNumber })
    if (hasNativeLiteralMathCandidate(content))
      literalMathPages.push({ page, content, viewport, pageNumber })
    if (hasNativeFunctionDisplay(content))
      nativeFunctions.push({ page, content, viewport, pageNumber })
    if (hasNativeMatrixCandidate(content) || hasNativeDerivativeMatrixCandidate(content))
      nativeMatrices.push({ page, content, viewport, pageNumber })
    for (const [index, rect] of readOutlierFontNavigation(page, content, viewport))
      outlierNavigation.set(`${pageNumber}:${index}`, rect)
    signal.throwIfAborted()
    const nativeNavigation = await readNativeType3Navigation(page, content, viewport, {
      signal,
      current: navigationCurrent
    })
    signal.throwIfAborted()
    if (nativeNavigation) {
      if (!nativeNavigation.current())
        throw new Error('PDF source changed during Type3 navigation verification')
      type3Navigation.push(nativeNavigation)
      for (const [index, rect] of nativeNavigation.regions)
        outlierNavigation.set(pageNumber + ':' + index, rect)
    }
    styles.push(content.styles ?? {})
    mathDiagrams.push(...(await readPdfMathDiagrams(page, pageNumber, content)))
    signal.throwIfAborted()
    if (pageTextItems === 0) pagesWithoutText.push(pageNumber)
    pages.push({
      page: pageNumber,
      width: viewport.width,
      height: viewport.height,
      // Item coordinates already include the default viewport rotation above. Group
      // readable horizontal prose in that space; sideways items still remain source-only.
      rotation: 0,
      items,
      nativeTableNoteEvidence: await readNativeTableNoteEvidence(
        page,
        content,
        new Set(
          [...unreliableItems]
            .filter((key) => key.startsWith(pageNumber + ':'))
            .map((key) => Number(key.split(':')[1]))
        )
      ),
      nativeReferenceEvidence,
      nativeDisplayMathEvidence,
      nativeDerivativeRuleEvidence: await readNativeDerivativeRuleEvidence(
        page,
        content,
        nativeDisplayMathEvidence
      ),
      nativeCompactAlgorithmEvidence: await readNativeCompactAlgorithmEvidence(page, content),
      nativeNumberedPacketEvidence: await readNativeNumberedPacketEvidence(
        page,
        content,
        nativeReferenceEvidence,
        nativeDisplayMathEvidence
      ),
      nativeFolioFontEvidence: await readNativeSectionFontEvidence(
        page,
        {
          ...content,
          items: content.items.filter((item) => 'str' in item && item.str === String(pageNumber))
        },
        { complete: false, reason: 'native-folio-font-subset' }
      ),
      nativeSectionFontEvidence: await readNativeSectionFontEvidence(
        page,
        content,
        nativeReferenceEvidence
      ),
      nativeCommandAdvances: await readNativeCommandAdvances(page, content)
    })
    await bindNativeReferenceRolePage(
      pages.at(-1)!,
      page,
      content,
      document,
      signal,
      unreliableItems,
      viewport
    )
    pages.at(-1)!.nativeAppendixOverview = await readNativeAppendixOverview({
      document,
      page,
      content,
      rawPage: pages.at(-1)!,
      sourceIdentity,
      signal,
      unreliable: new Set(
        [...unreliableItems]
          .filter((key) => key.startsWith(pageNumber + ':'))
          .map((key) => Number(key.split(':')[1]))
      )
    })
    const restartInput = {
      document,
      page,
      content,
      rawPage: pages.at(-1)!,
      sourceIdentity,
      signal,
      unreliable: new Set(
        [...unreliableItems]
          .filter((key) => key.startsWith(pageNumber + ':'))
          .map((key) => Number(key.split(':')[1]))
      )
    }
    pages.at(-1)!.nativeOutlineRestart = await readNativeOutlineRestart(restartInput)
    pages.at(-1)!.nativeOnlineAppendixRestart = await readNativeOnlineAppendixRestart(
      restartInput,
      onlineContexts.slice()
    )
    pages.at(-1)!.nativeContentsReference = await readNativeContentsReference(restartInput)
    onlineContexts.push(restartInput)
    if (onlineContexts.length > 2) onlineContexts.shift()
    await taggedReferences.observe({ ...restartInput, viewport })
    await algorithmCaptions.observe({ ...restartInput, viewport })
    terminalCaptions.observe({ ...restartInput, viewport })
    const captionTerminal = await rememberNativeCaptionTerminal({
      document,
      page,
      content,
      rawPage: pages.at(-1)!,
      signal
    })
    if (captionTerminal) captionTerminals.push(captionTerminal)
    onProgress?.(pageNumber)
    // Let the reader paint and deliver cancellation between page reads.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    signal.throwIfAborted()
  }
  checkType3Navigation()
  checkOcclusions()
  checkCaptionTerminals()
  await terminalCaptions.prepare(pages)
  signal.throwIfAborted()
  // ponytail: grouping is synchronous; move it to a worker if long-document profiling requires it.
  const layout = preservePdfMathDiagrams(
    groupPdfTranslationPages({ pages, pageCount: document.numPages }),
    mathDiagrams
  )
  const terminalSource = bindNativeTerminalCaptionLayout(layout, pages, {
    resourceRequestKey,
    fingerprint
  })
  const units: PdfTranslationSource['units'][number][] = []
  const independent: PdfTranslationSource['units'][number][] = []
  const independentWarnings: PdfTranslationExtraction['coverage']['warnings'][number][] = []
  const warnings: PdfTranslationExtraction['coverage']['warnings'][number][] = []
  const accounted = new Set(
    exclusions.flatMap((entry) => entry.items.map((item) => `${item.pageNumber}:${item.index}`))
  )
  for (const unit of layout.units) {
    signal.throwIfAborted()
    let reason: PdfTranslationExclusionReason | undefined
    if (unit.risks.includes('unsupported-orientation')) reason = 'unsupported-orientation'
    const fragments = unit.fragments.flatMap((fragment) => {
      const page = layout.pages[fragment.page - 1]
      const block = page.blocks.find((block) => block.id === fragment.id)!
      const r = fragment.rect
      const rect = {
        x: r.x / page.width,
        y: r.y / page.height,
        width: (r.right - r.x) / page.width,
        height: (r.bottom - r.y) / page.height
      }
      if (
        !reason &&
        (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0)
      )
        reason = 'invalid-geometry'
      if (
        !reason &&
        (rect.x < 0 ||
          rect.y < 0 ||
          rect.x + rect.width > 1.000001 ||
          rect.y + rect.height > 1.000001)
      )
        reason = 'outside-page'
      const items = block.items
        .map((key, index) => {
          if (accounted.has(key)) throw new Error('Duplicate PDF source item ownership')
          accounted.add(key)
          return {
            index: Number(key.split(':')[1]),
            text: block.originalStrings[index]
          }
        })
        .sort((a, b) => a.index - b.index)
      // A wide caption above a narrow column can create a bounding box containing
      // another block. Retain the unit identity/text but use its existing line boxes.
      const overlaps = page.blocks.some(
        (other) =>
          other.id !== block.id &&
          other.rect.x < r.right &&
          other.rect.right > r.x &&
          other.rect.y < r.bottom &&
          other.rect.bottom > r.y
      )
      return overlaps && block.lines.length > 1 && !reason
        ? block.lines.map((line) => ({
            pageNumber: fragment.page,
            rect: {
              x: line.x / page.width,
              y: line.y / page.height,
              width: (line.right - line.x) / page.width,
              height: (line.bottom - line.y) / page.height
            },
            items: items.filter((item) => line.items.includes(fragment.page + ':' + item.index))
          }))
        : [{ pageNumber: fragment.page, rect, items }]
    })
    // Keep the established grouping/IDs unchanged. Recover only isolated original items;
    // never merge a rotated table's values through the prose grouping heuristic.
    if (
      reason === 'unsupported-orientation' &&
      fragments.length === 1 &&
      fragments[0].items.length === 1
    ) {
      const fragment = fragments[0],
        original = fragment.items[0]
      const page = pages[fragment.pageNumber - 1],
        item = page.items[original.index]
      const rect =
        independentRect(item, page, styles[fragment.pageNumber - 1][item.fontName ?? '']) ??
        outlierNavigation.get(`${fragment.pageNumber}:${original.index}`)
      if (rect) {
        const id = `rot-p${fragment.pageNumber}-i${original.index}`
        independent.push({
          id,
          source: original.text,
          sourceOnly: true,
          fragments: [{ ...fragment, rect }]
        })
        if (unreliableItems.has(`${fragment.pageNumber}:${original.index}`))
          warnings.push(
            Object.freeze({
              unitId: id,
              reasons: Object.freeze(['unreliable-font-unicode'])
            })
          )
        continue
      }
    }
    if (reason) {
      const remaining = fragments.flatMap((fragment) =>
        fragment.items.flatMap((original) => {
          if (reason === 'outside-page') {
            const page = pages[fragment.pageNumber - 1],
              item = page.items[original.index],
              style = styles[fragment.pageNumber - 1][item.fontName ?? '']
            // One overflowing peer must not discard a complete page-in item.
            // The broken group proves no paragraph contract: retain only a
            // separately bounded original anchor, using explicit native metrics.
            const rect =
              item.fontName &&
              style?.vertical === false &&
              Number.isFinite(style.ascent) &&
              Number.isFinite(style.descent)
                ? independentRect(item, page, style)
                : undefined
            if (rect) {
              const id = `inpage-p${fragment.pageNumber}-i${original.index}`
              independent.push({
                id,
                source: original.text,
                sourceOnly: true,
                fragments: [{ pageNumber: fragment.pageNumber, rect, items: [original] }]
              })
              const reasons = [...unit.risks]
              if (unreliableItems.has(`${fragment.pageNumber}:${original.index}`))
                reasons.push('unreliable-font-unicode')
              if (reasons.length)
                independentWarnings.push(
                  Object.freeze({
                    unitId: id,
                    reasons: Object.freeze(reasons)
                  })
                )
              return []
            }
            const partial = partialNavigation.get(`${fragment.pageNumber}:${original.index}`)
            if (partial) {
              const id = `clipped-p${fragment.pageNumber}-i${original.index}`
              independent.push({
                id,
                source: original.text,
                sourceOnly: true,
                fragments: [
                  {
                    pageNumber: fragment.pageNumber,
                    ...partial,
                    items: [original]
                  }
                ]
              })
              const reasons = ['partially-outside-page']
              if (unreliableItems.has(`${fragment.pageNumber}:${original.index}`))
                reasons.push('unreliable-font-unicode')
              independentWarnings.push(
                Object.freeze({ unitId: id, reasons: Object.freeze(reasons) })
              )
              return []
            }
          }
          return [{ ...original, pageNumber: fragment.pageNumber }]
        })
      )
      if (remaining.length) exclusions.push({ unitId: unit.id, reason, items: remaining })
    } else {
      const unreliable = fragments.some((fragment) =>
        fragment.items.some((item) => unreliableItems.has(`${fragment.pageNumber}:${item.index}`))
      )
      const opaqueControlRun =
        unit.source.includes('\u0000') &&
        unit.originalStrings.every((text) => /^[\p{Cc}\s]*$/u.test(text))
      // Keep a proved missing-Unicode symbol on its existing original navigation.
      // Ordinary words and mixed prose retain their established admission.
      const opaqueMathRun =
        unreliable &&
        !unit.figure &&
        !unit.referenceBoundary &&
        fragments.length > 0 &&
        fragments.every(
          (fragment) =>
            fragment.pageNumber === fragments[0].pageNumber &&
            fragment.items.length > 0 &&
            fragment.items.every(
              ({ index, text }) =>
                unreliableMathItems.has(`${fragment.pageNumber}:${index}`) &&
                pages[fragment.pageNumber - 1].items[index].str === text
            )
        )
      // A damaged formula can leave the same unfinished clause at the end
      // of adjacent rows. That repeated tail has no independent translation.
      const [head, tail] = fragments
      const repeatedMathTail =
        unreliable &&
        !unit.figure &&
        !unit.referenceBoundary &&
        fragments.length === 2 &&
        head.pageNumber === tail.pageNumber &&
        head.rect.width < 0.14 &&
        tail.rect.width < 0.14 &&
        Math.abs(head.rect.x + head.rect.width - tail.rect.x - tail.rect.width) <
          head.rect.height * 0.3 &&
        tail.rect.y - head.rect.y > head.rect.height * 0.7 &&
        tail.rect.y - head.rect.y < head.rect.height * 1.45 &&
        (() => {
          const suffixes = [head, tail].map(({ pageNumber, items }) => {
            const [first, ...words] = items
            if (
              !first ||
              !unreliableMathItems.has(`${pageNumber}:${first.index}`) ||
              pages[pageNumber - 1].items[first.index].str !== first.text
            )
              return ''
            return words
              .map(({ text }) => text)
              .join(' ')
              .replace(/^[)\] ]+/u, '')
              .trim()
          })
          return suffixes[0] === suffixes[1] && /^\p{Ll}{2,12} (?:no|the|a|an)$/u.test(suffixes[0])
        })()
      // An isolated native square is a mark with no text to translate.
      const standaloneSquare =
        unit.source === '□' &&
        !unit.sourceOnly &&
        !unit.figure &&
        !unit.referenceBoundary &&
        !unreliable &&
        fragments.length === 1 &&
        head.items.length === 1 &&
        head.items[0].text === unit.source
      const standaloneTensorPower =
        unit.source.startsWith('⊗') &&
        !unit.sourceOnly &&
        !unit.preserve &&
        !unit.figure &&
        !unit.referenceBoundary &&
        !unreliable &&
        fragments.length === 1 &&
        head.items.length === 2 &&
        head.items[0].index + 1 === head.items[1].index &&
        head.items[0].text + head.items[1].text === unit.source &&
        isNativeTensorPower(pages[head.pageNumber - 1].items, head.items[0].index)
      const preserve =
        unit.preserve ??
        (opaqueMathRun ? 'formula' : undefined) ??
        (standaloneSquare || standaloneTensorPower ? 'literal' : undefined)
      const sourceOnly =
        unit.sourceOnly ||
        opaqueMathRun ||
        standaloneSquare ||
        standaloneTensorPower ||
        repeatedMathTail ||
        opaqueControlRun ||
        (unreliable &&
          [...unit.source].length <= 32 &&
          !/[\p{L}\p{M}]{2}/u.test(unit.source) &&
          [...unit.source].some((character) => {
            const code = character.codePointAt(0)!
            return code < 32 && code !== 9 && code !== 10 && code !== 13
          }) &&
          fragments.length > 0 &&
          fragments.reduce((count, fragment) => count + fragment.items.length, 0) <= 4 &&
          fragments.every(
            (fragment) =>
              fragment.pageNumber === fragments[0].pageNumber &&
              fragment.items.length > 0 &&
              fragment.items.every((item) => {
                const native = pages[fragment.pageNumber - 1].items[item.index]
                return (
                  native.str === item.text &&
                  Number.isFinite(native.width) &&
                  native.width > 0 &&
                  Number.isFinite(native.height) &&
                  native.height > 0
                )
              })
          ))
      const extracted = {
        id: unit.id,
        source: unit.source,
        ...(sourceOnly ? { sourceOnly: true as const } : {}),
        ...(preserve ? { preserve } : {}),
        ...(unit.figure ? { figure: true as const } : {}),
        ...(unit.referenceBoundary ? { referenceBoundary: true as const } : {}),
        fragments
      }
      terminalSource?.observe(unit, extracted)
      const firstPageBlock =
        fragments[0]?.pageNumber === 1 && extracted.source.startsWith('Keywords: ')
          ? layout.pages[0].blocks.find(({ id }) => id === unit.fragments[0].id)
          : undefined
      const split =
        !unreliable &&
        unit.risks.length === 0 &&
        ((firstPageBlock && splitCoverAuthorFields(extracted, pages[0], firstPageBlock)) ||
          splitCorrespondenceFromAbstract(extracted, pages[0]))
      const relation = !unreliable && splitAcrossProtectedRelation(units.at(-1), extracted, pages)
      if (relation) units.splice(-1, 1, ...relation)
      else units.push(...(split || [extracted]))
      const reasons = [...unit.risks]
      if (unreliable || opaqueControlRun) reasons.push('unreliable-font-unicode')
      if (reasons.length)
        warnings.push(Object.freeze({ unitId: unit.id, reasons: Object.freeze(reasons) }))
    }
  }
  if (accounted.size !== textItemCount) throw new Error('Incomplete PDF source item coverage')
  // Retain native item order for independent anchors; this is not inferred table reading order.
  independent.sort(
    (a, b) =>
      a.fragments[0].pageNumber - b.fragments[0].pageNumber ||
      a.fragments[0].items[0].index - b.fragments[0].items[0].index
  )
  warnings.push(...independentWarnings)
  const excludedItemCount = exclusions.reduce((count, entry) => count + entry.items.length, 0)
  let finalUnits = retainFragmentedMathCondition(
    terminalContactSources([...units, ...independent], layout, pages, document.numPages),
    pages[0]
  )
  finalUnits = separateRepeatedAffiliationAddresses(finalUnits, pages[0])
  finalUnits = preserveFractionDifferentials(finalUnits, pages)
  for (const context of shortMathPages) {
    signal.throwIfAborted()
    finalUnits = [
      ...(await nativeShortMathContinuations(
        finalUnits,
        context.page,
        context.content,
        context.viewport,
        context.pageNumber
      ))
    ]
  }
  if (scopedDisplays.length) {
    const auxiliary = createAuxiliaryNativeDisplayInkReader({
        document,
        sourceIdentity,
        nativeDocumentFactory,
        signal
      }),
      protectedOwners = new Set<string>()
    try {
      for (const context of scopedDisplays) {
        signal.throwIfAborted()
        for (const id of await nativeScopedDisplayOwners(
          finalUnits,
          context.page,
          context.content,
          context.viewport,
          context.pageNumber,
          auxiliary
        ))
          protectedOwners.add(id)
        signal.throwIfAborted()
      }
    } finally {
      await auxiliary.dispose()
    }
    finalUnits = finalUnits.map((unit) =>
      protectedOwners.has(unit.id) && !unit.sourceOnly && !unit.preserve
        ? { ...unit, sourceOnly: true as const, preserve: 'formula' as const }
        : unit
    )
  }
  // This monotone branch withdraws translation eligibility only. It does not
  // grant formula ink evidence or change native owners, fragments or geometry.
  for (const context of literalMathPages) {
    signal.throwIfAborted()
    const protectedOwners = await nativeLiteralMathOwners(
      finalUnits,
      context.page,
      context.content,
      context.viewport,
      context.pageNumber
    )
    finalUnits = finalUnits.map((unit) =>
      protectedOwners.has(unit.id) && !unit.sourceOnly && !unit.preserve
        ? { ...unit, sourceOnly: true as const, preserve: 'literal' as const }
        : unit
    )
  }

  const productTerms = nativeDisplayProductTerms(finalUnits, pages)
  finalUnits = finalUnits.map((unit) =>
    productTerms.has(unit.id)
      ? { ...unit, sourceOnly: true as const, preserve: 'literal' as const }
      : unit
  )
  if (nativeMatrices.length) {
    const reader = createNativeMatrixReader({
        document,
        sourceIdentity,
        nativeDocumentFactory,
        signal
      }),
      protectedOwners = new Set<string>()
    try {
      for (const context of nativeMatrices)
        for (const id of await nativeMatrixOwners(
          finalUnits,
          context.page,
          context.content,
          context.viewport,
          context.pageNumber,
          reader
        ))
          protectedOwners.add(id)
    } finally {
      await reader.dispose()
    }
    signal.throwIfAborted()
    finalUnits = finalUnits.map((unit) =>
      protectedOwners.has(unit.id)
        ? { ...unit, sourceOnly: true as const, preserve: 'formula' as const }
        : unit
    )
  }
  if (nativeFunctions.length) {
    const reader = createNativeFunctionDisplayReader({
        document,
        sourceIdentity,
        nativeDocumentFactory,
        signal
      }),
      protectedOwners = new Set<string>()
    try {
      for (const context of nativeFunctions)
        for (const id of await nativeFunctionDisplayOwners(
          finalUnits,
          context.page,
          context.content,
          context.viewport,
          context.pageNumber,
          reader
        ))
          protectedOwners.add(id)
    } finally {
      await reader.dispose()
    }
    signal.throwIfAborted()
    finalUnits = finalUnits.map((unit) =>
      protectedOwners.has(unit.id)
        ? { ...unit, sourceOnly: true as const, preserve: 'formula' as const }
        : unit
    )
  }
  await taggedReferences.owners(finalUnits, pages)
  const taggedOwners = taggedReferences.currentOwners(finalUnits, pages)
  finalUnits = finalUnits.map((unit) => {
    const role = taggedOwners.get(unit.id)
    return role === 'reference'
      ? { ...unit, sourceOnly: true as const, preserve: 'reference' as const }
      : role === 'original-only-url'
        ? { ...unit, sourceOnly: true as const }
        : unit
  })
  const tableCaptionOwners = await nativeTableCaptionOwners(finalUnits, document, signal)
  finalUnits = finalUnits.map((unit) => {
    if (!tableCaptionOwners.has(unit.id)) return unit
    const restored = { ...unit }
    delete restored.sourceOnly
    delete restored.preserve
    return restored
  })
  signal.throwIfAborted()
  checkType3Navigation()
  checkOcclusions()
  checkCaptionTerminals()
  if (
    !nativeReferenceRolePagesCurrent(pages, unreliableItems) ||
    !nativeOwnedReferenceRolesCurrent(pages)
  )
    throw new Error('Native reference sources changed during extraction')
  const undecodedDisplays = unreliablyDecodedDisplayOwners(pages, finalUnits, unreliableItems)
  if (undecodedDisplays.size)
    finalUnits = finalUnits.map((unit) =>
      undecodedDisplays.has(unit.id) ? { ...unit, sourceOnly: true as const } : unit
    )
  const nativeNumbers = nativeBundledScientificOwners(pages, finalUnits)
  if (nativeNumbers.size)
    finalUnits = finalUnits.map((unit) =>
      nativeNumbers.has(unit.id) ? { ...unit, sourceOnly: true as const } : unit
    )
  finalUnits = joinInlineFormulaWordWrap(finalUnits, pages)
  finalUnits = joinPrintedFunctionDefinitions(finalUnits, pages)
  finalUnits = joinFormulaAdjacentSentenceWraps(finalUnits, pages)
  finalUnits = joinWrappedInductionPremises(finalUnits, pages)
  finalUnits = joinTerminalComparisonWraps(finalUnits, pages)
  finalUnits = restoreInlineCoefficientReadingOrder(finalUnits, pages)
  const sourceInput = {
    resourceRequestKey,
    fingerprint,
    pages,
    units: finalUnits
  }
  const source = terminalSource?.create(sourceInput) ?? createPdfTranslationSource(sourceInput)
  rememberNativeCaptionEligibility(source, tableCaptionOwners)
  rememberPdfTranslationSourceParser(source)
  return Object.freeze({
    source,
    coverage: Object.freeze({
      pageCount: pages.length,
      textItemCount,
      includedItemCount: textItemCount - excludedItemCount,
      excludedItemCount,
      pagesWithoutText: Object.freeze(pagesWithoutText),
      ...(pageDiagnostics.length ? { pageDiagnostics: Object.freeze(pageDiagnostics) } : {}),
      exclusions: Object.freeze(
        exclusions.map((entry) =>
          Object.freeze({
            ...entry,
            items: Object.freeze(entry.items.map((item) => Object.freeze(item)))
          })
        )
      ),
      warnings: Object.freeze(warnings)
    })
  })
}
