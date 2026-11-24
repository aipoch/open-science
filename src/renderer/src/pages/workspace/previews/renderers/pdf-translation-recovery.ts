import {
  pdfGenerationFailure,
  type PdfGenerationFailure,
  type PdfTranslationLayoutFailure
} from '@aipoch/pdf-translation/contracts'
import type { PdfTranslationVerificationLocation } from './pdf-translation-verification'

type PageFailure = Pick<PdfTranslationLayoutFailure, 'code' | 'phase'>

type Recovery =
  | { action: 'bypass-cache' }
  | { action: 'keep-links'; pageNumber: number; links: ReadonlyMap<number, string> }
  | { action: 'keep-unit'; unitId: string }
  | { action: 'keep-page'; pageNumber: number; reason: PageFailure }
  | { action: 'report-error'; failure: PdfGenerationFailure }

// Recovery increases the original content retained on each attempt. The
// caller owns the per-generation history and verifies each candidate again.
export function decidePdfTranslationRecovery({
  cause,
  verification,
  cacheHit,
  bypassCache,
  useArtifact,
  pageCount,
  originalPages,
  canKeepUnit,
  hasOtherTranslationOnPage
}: {
  cause: unknown
  verification: PdfTranslationVerificationLocation | undefined
  cacheHit: boolean
  bypassCache: boolean
  useArtifact: boolean
  pageCount: number
  originalPages: ReadonlyMap<number, PageFailure>
  canKeepUnit: (unitId: string) => boolean
  hasOtherTranslationOnPage: (unitId: string, pageNumber: number | undefined) => boolean
}): Recovery {
  if (verification && cacheHit && !bypassCache) return { action: 'bypass-cache' }
  const generationFailure = pdfGenerationFailure(cause)
  const pageNumber = verification
    ? verification.pageNumber
    : generationFailure.pageLocal
      ? generationFailure.pageNumber
      : undefined
  if (
    verification?.reason === 'moved-link' &&
    pageNumber !== undefined &&
    verification.failedLinks?.size
  )
    return { action: 'keep-links', pageNumber, links: verification.failedLinks }

  const unitId = verification?.unitId
  const reason = verification?.reason
  if (
    !useArtifact &&
    (reason === 'unit-placement' ||
      reason === 'literal-example' ||
      reason === 'overlapping-owner') &&
    unitId &&
    canKeepUnit(unitId) &&
    (reason === 'literal-example' || hasOtherTranslationOnPage(unitId, pageNumber))
  )
    return { action: 'keep-unit', unitId }

  if (
    !useArtifact &&
    pageNumber !== undefined &&
    pageNumber >= 1 &&
    pageNumber <= pageCount &&
    !originalPages.has(pageNumber)
  )
    return {
      action: 'keep-page',
      pageNumber,
      reason: verification
        ? { code: 'validation-failed', phase: 'verification' }
        : {
            code: generationFailure.code as PdfTranslationLayoutFailure['code'],
            phase: 'generation'
          }
    }

  return {
    action: 'report-error',
    failure: verification
      ? { code: 'validation-failed', pageNumber: verification.pageNumber }
      : generationFailure
  }
}
