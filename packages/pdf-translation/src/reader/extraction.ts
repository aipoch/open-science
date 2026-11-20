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
import { hasNativeDisplaySequence, nativeScopedDisplayOwners } from './native-display-packets.js'
import {
  hasNativeShortMathContinuation,
  nativeShortMathContinuations
} from './native-short-math-continuation.js'
import { hasNativeLiteralMathCandidate, nativeLiteralMathOwners } from './native-literal-math.js'
import {
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
import { groupPdfTranslationPages, type PdfLayoutPage, type PdfLayoutTextItem } from './layout.js'
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
      items: readonly Readonly<{ pageNumber: number; index: number; text: string }>[]
    }>[]
    /** Advisory grouping or decoding uncertainty; never silently removes source text. */
    warnings: readonly Readonly<{ unitId: string; reasons: readonly string[] }>[]
    /** Painted glyphs without a native text owner; does not change translation eligibility. */
    pageDiagnostics?: readonly Readonly<{ pageNumber: number; reason: 'unreliable-font-unicode' }>[]
  }>
}>

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
    { ...unit, id: `${unit.id}-affiliation`, source: affiliationText, fragments: [affiliation] },
    { ...unit, id: `${unit.id}-contact`, source: contactText, fragments: [contact] },
    { ...unit, source: unit.source.slice(prefix.length), fragments: body }
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
    { ...unit, source: unit.source.slice(0, -(source.length + 1)), fragments: [head] },
    prefix,
    { ...unit, id: unit.id + '-relation-tail', source, fragments: [tail] }
  ]
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
  sourceIdentity?: Readonly<{ sourceChecksum: string; sourceSizeBytes: number }>
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
    return await readPdfTranslationSource({ ...input, nativeExclusions: exclusions })
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
      (indexes) => {
        for (const index of indexes) unreliableItems.add(`${pageNumber}:${index}`)
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
    if (!nativeDisplayMathEvidence.complete && hasNativeDisplaySequence(content))
      scopedDisplays.push({ page, content, viewport, pageNumber })
    if (hasNativeShortMathContinuation(content))
      shortMathPages.push({ page, content, viewport, pageNumber })
    if (hasNativeLiteralMathCandidate(content))
      literalMathPages.push({ page, content, viewport, pageNumber })
    if (hasNativeFunctionDisplay(content))
      nativeFunctions.push({ page, content, viewport, pageNumber })
    if (hasNativeMatrixCandidate(content))
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
          return { index: Number(key.split(':')[1]), text: block.originalStrings[index] }
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
            Object.freeze({ unitId: id, reasons: Object.freeze(['unreliable-font-unicode']) })
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
                  Object.freeze({ unitId: id, reasons: Object.freeze(reasons) })
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
                fragments: [{ pageNumber: fragment.pageNumber, ...partial, items: [original] }]
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
      const sourceOnly =
        unit.sourceOnly ||
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
        ...(unit.preserve ? { preserve: unit.preserve } : {}),
        ...(unit.figure ? { figure: true as const } : {}),
        ...(unit.referenceBoundary ? { referenceBoundary: true as const } : {}),
        fragments
      }
      terminalSource?.observe(unit, extracted)
      const split =
        !unreliable &&
        unit.risks.length === 0 &&
        splitCorrespondenceFromAbstract(extracted, pages[0])
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
  const sourceInput = { resourceRequestKey, fingerprint, pages, units: finalUnits }
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
