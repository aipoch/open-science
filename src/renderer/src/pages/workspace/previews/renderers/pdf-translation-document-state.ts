import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfTranslationFragment } from '@aipoch/pdf-translation/reader'
import type { PdfGenerationFailure } from '@aipoch/pdf-translation/contracts'

export type PdfTranslationPageGeometry = Readonly<{
  width: number
  height: number
  rotation: number
}>

export type PdfTranslationDocumentState =
  | { status: 'idle' }
  | { status: 'loading'; phase: 'generating' | 'validating' }
  | {
      status: 'error'
      failure: PdfGenerationFailure
      details?: string
      unitId?: string
      retryUnchanged?: boolean
    }
  | {
      status: 'ready'
      document: PDFDocumentProxy
      pages: readonly PdfTranslationPageGeometry[]
      originalUnitCount: number
      retainedUnitIds: readonly string[]
      unchangedLayoutUnitIds?: readonly string[]
      sourcePageNumbers?: readonly number[]
      sourcePages?: readonly (readonly number[])[]
      originalPageNumbers?: readonly number[]
      unitFragments?: Readonly<Record<string, readonly PdfTranslationFragment[]>>
    }
