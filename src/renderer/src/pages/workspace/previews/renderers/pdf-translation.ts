import {
  pdfTranslationBlockFailureSchema,
  type PdfTranslationCheckpointRequest,
  type PdfTranslationLayoutFailure,
  type PdfTranslationBlockFailure
} from '../../../../../../shared/pdf-translation'
import { getPdfTranslationTextContent } from './pdf-translation-text-content'
import type { PDFDocumentProxy } from 'pdfjs-dist'

export type PdfRendition = 'original' | 'translated' | 'compare'
export type PdfTranslationFragment = Readonly<{
  pageNumber: number
  // Normalized, top-left coordinates in the default PDF.js viewport.
  rect: Readonly<{ x: number; y: number; width: number; height: number }>
  items: readonly Readonly<{ index: number; text: string }>[]
}>
export type PdfTranslationUnit = Readonly<{
  id: string
  /** Original reading-order number, assigned by the source binder before displaying results. */
  paragraphNumber?: number
  source: string
  translationSource: string
  translation: string
  translationFailed?: true
  failure?: PdfTranslationBlockFailure
  fragments: readonly PdfTranslationFragment[]
}>
export type PdfTranslation = Readonly<{
  resourceRequestKey: string
  fingerprint: string
  pages: readonly Readonly<{ width: number; height: number }>[]
  units: readonly PdfTranslationUnit[]
}>

// Only the local extraction owner creates this snapshot, before translation starts.
// Results hold its identity; they never supply replacement source text or coordinates.
const sourceSnapshot = Symbol('PDF translation source')
type PdfTranslationSourceData = Readonly<{
  resourceRequestKey: string
  fingerprint: string
  pages: PdfTranslation['pages']
  units: readonly Readonly<
    Pick<PdfTranslationUnit, 'id' | 'source' | 'fragments'> & {
      /** Located source only; no paragraph/table translation contract has been established. */
      sourceOnly?: true
    }
  >[]
}>
export type PdfTranslationSource = PdfTranslationSourceData & {
  readonly [sourceSnapshot]: true
}
export type PdfTranslationResults = Readonly<{
  source: PdfTranslationSource
  checkpoint?: Readonly<{ key: string; source: PdfTranslationCheckpointRequest }>
  /** Rejected blocks remain original text, separate from accepted translations. */
  failedUnitIds?: readonly string[]
  failures?: Readonly<Record<string, PdfTranslationBlockFailure>>
  layoutFailures?: Readonly<Record<string, PdfTranslationLayoutFailure>>
  units: readonly Readonly<Pick<PdfTranslationUnit, 'id' | 'translationSource' | 'translation'>>[]
}>

// Parallel completion and retries can insert earlier paragraphs into source order.
// Retain a verified snapshot while its accepted units still belong to this source.
export function isPdfTranslationResultExtension(
  previous: PdfTranslationResults,
  current: PdfTranslationResults,
  allowReplacement = false
): boolean {
  if (
    previous.checkpoint?.key !== current.checkpoint?.key ||
    previous.source !== current.source ||
    previous.units.length > current.units.length
  )
    return false
  const byId = new Map(current.units.map((unit) => [unit.id, unit]))
  if (byId.size !== current.units.length) return false
  return previous.units.every((unit) => {
    const next = byId.get(unit.id)
    return (
      next?.translationSource === unit.translationSource &&
      (allowReplacement || next.translation === unit.translation)
    )
  })
}

export function createPdfTranslationSource(input: PdfTranslationSourceData): PdfTranslationSource {
  return Object.freeze({
    [sourceSnapshot]: true as const,
    resourceRequestKey: input.resourceRequestKey,
    fingerprint: input.fingerprint,
    pages: Object.freeze(input.pages.map(({ width, height }) => Object.freeze({ width, height }))),
    units: Object.freeze(
      input.units.map(({ id, source, fragments, sourceOnly }) =>
        Object.freeze({
          id,
          source,
          ...(sourceOnly === true ? { sourceOnly: true as const } : {}),
          fragments: Object.freeze(
            fragments.map(({ pageNumber, rect, items }) =>
              Object.freeze({
                pageNumber,
                rect: Object.freeze({
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height
                }),
                items: Object.freeze(items.map(({ index, text }) => Object.freeze({ index, text })))
              })
            )
          )
        })
      )
    )
  })
}

// Compose display data only from the independently owned source. Copy result strings
// before awaiting PDF reads so in-flight payload mutation cannot change the bound result.
export async function bindPdfTranslation(
  source: PdfTranslationSource,
  results: PdfTranslationResults,
  document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>,
  resourceRequestKey: string,
  signal: AbortSignal
): Promise<PdfTranslation | null> {
  return bindTranslation(
    source,
    results,
    document,
    resourceRequestKey,
    signal,
    verifyPdfTranslationSource
  )
}

// One binder belongs to one reader generation. Only successful checks of the exact
// immutable snapshot/document pair are reused; result records are always validated.
export function createPdfTranslationBinder(): typeof bindPdfTranslation {
  let verified:
    | {
        source: PdfTranslationSource
        document: Parameters<typeof bindPdfTranslation>[2]
        key: string
        units: PdfTranslation['units']
      }
    | undefined
  return async (source, results, document, key, signal) => {
    const previous = verified
    // Recovery can fill earlier gaps after later paragraphs were already accepted.
    // Bound units follow source order; incoming results follow completion order.
    const current = new Map(results.units.map((unit) => [unit.id, unit]))
    const appendOnly =
      previous?.source === source &&
      previous.document === document &&
      previous.key === key &&
      results.units.length >= previous.units.length &&
      previous.units.every((unit) => {
        const next = current.get(unit.id)
        return (
          next?.id === unit.id &&
          next.translation === unit.translation &&
          next.translationSource === unit.translationSource
        )
      })
    const value = await bindTranslation(
      source,
      results,
      document,
      key,
      signal,
      async (input, pdf, requestKey, abort) => {
        if (abort.aborted) return false
        if (
          appendOnly &&
          input.fingerprint === pdf.fingerprints[0] &&
          input.pages.length === pdf.numPages
        )
          return true
        return verifyPdfTranslationSource(input, pdf, requestKey, abort)
      }
    )
    if (value && !signal.aborted) verified = { source, document, key, units: value.units }
    return value
  }
}

async function bindTranslation(
  source: PdfTranslationSource,
  results: PdfTranslationResults,
  document: Parameters<typeof bindPdfTranslation>[2],
  resourceRequestKey: string,
  signal: AbortSignal,
  verify: typeof verifyPdfTranslationSource
): Promise<PdfTranslation | null> {
  if (
    !source[sourceSnapshot] ||
    results.source !== source ||
    (!results.units.length && !results.failedUnitIds?.length)
  )
    return null
  const sources = new Map(
      source.units
        .filter((unit) => !unit.sourceOnly)
        .map((unit, index) => [unit.id, { ...unit, paragraphNumber: index + 1 }])
    ),
    bound = new Map<string, PdfTranslationUnit>()
  for (const result of results.units) {
    const unit = sources.get(result.id)
    if (
      !unit ||
      unit.sourceOnly ||
      bound.has(result.id) ||
      typeof result.translationSource !== 'string' ||
      typeof result.translation !== 'string'
    )
      return null
    bound.set(
      result.id,
      Object.freeze({
        ...unit,
        translationSource: result.translationSource,
        translation: result.translation
      })
    )
  }
  for (const id of results.failedUnitIds ?? []) {
    const unit = sources.get(id)
    if (!unit || unit.sourceOnly || bound.has(id)) return null
    const failure = results.failures?.[id]
      ? pdfTranslationBlockFailureSchema.safeParse(results.failures[id])
      : undefined
    if (failure && !failure.success) return null
    bound.set(
      id,
      Object.freeze({
        ...unit,
        translationSource: unit.source,
        translation: '',
        translationFailed: true,
        ...(failure?.success ? { failure: Object.freeze(failure.data) } : {})
      })
    )
  }
  if (!(await verify(source, document, resourceRequestKey, signal)) || signal.aborted) return null
  return Object.freeze({
    resourceRequestKey: source.resourceRequestKey,
    fingerprint: source.fingerprint,
    pages: source.pages,
    units: Object.freeze(source.units.flatMap((unit) => bound.get(unit.id) ?? []))
  })
}

export const isCurrentTranslation = (unit: PdfTranslationUnit): boolean =>
  unit.source === unit.translationSource && Boolean(unit.translation.trim())

// The caller owns cancellation and the PDF document. Never clean up a shared page proxy here.
async function verifyPdfTranslationSource(
  input: PdfTranslationSource,
  document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>,
  resourceRequestKey: string,
  signal: AbortSignal
): Promise<boolean> {
  if (
    signal.aborted ||
    input.resourceRequestKey !== resourceRequestKey ||
    !input.fingerprint ||
    input.fingerprint !== document.fingerprints[0] ||
    input.pages.length !== document.numPages ||
    !input.units.length
  )
    return false
  const ids = new Set<string>(),
    ownedItems = new Set<string>()
  const fragments = new Map<number, PdfTranslationFragment[]>()
  for (const unit of input.units) {
    if (!unit.id || ids.has(unit.id) || !unit.source.trim() || !unit.fragments.length) return false
    ids.add(unit.id)
    for (const fragment of unit.fragments) {
      const { pageNumber, rect, items } = fragment
      if (
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > document.numPages ||
        !items.length ||
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x + rect.width > 1.000001 ||
        rect.y + rect.height > 1.000001
      )
        return false
      let previousIndex = -1
      for (const item of items) {
        const key = `${pageNumber}:${item.index}`
        if (
          !Number.isInteger(item.index) ||
          item.index <= previousIndex ||
          !item.text.trim() ||
          ownedItems.has(key)
        )
          return false
        previousIndex = item.index
        ownedItems.add(key)
      }
      fragments.set(pageNumber, [...(fragments.get(pageNumber) ?? []), fragment])
    }
  }
  for (const [pageNumber, pageFragments] of fragments) {
    if (signal.aborted) return false
    const page = await document.getPage(pageNumber)
    if (signal.aborted) return false
    const viewport = page.getViewport({ scale: 1 }),
      geometry = input.pages[pageNumber - 1]
    if (
      !Number.isFinite(geometry.width) ||
      !Number.isFinite(geometry.height) ||
      Math.abs(viewport.width - geometry.width) > 0.01 ||
      Math.abs(viewport.height - geometry.height) > 0.01
    )
      return false
    const content = await getPdfTranslationTextContent(page)
    if (signal.aborted) return false
    for (const fragment of pageFragments)
      for (const item of fragment.items) {
        const current = content.items[item.index]
        if (!current || !('str' in current) || current.str !== item.text) return false
      }
  }
  return !signal.aborted
}
