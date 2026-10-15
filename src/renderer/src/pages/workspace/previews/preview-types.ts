import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { Annotation } from '../../../../../shared/annotation-contract'
import type { AnnotationValidationError } from '../../../../../shared/annotations'
import type { PdfProseRegion } from '../../../../../shared/pdf-text'
import type {
  PdfReadingPosition,
  SessionPdfContextSource
} from '../../../../../shared/session-persistence'

export type ActivePdfTranslation = {
  done: number
  total: number
  cancel: () => void
}

export type PreviewFileRendererProps = {
  item: PreviewFileItem
  readOnly?: boolean
  presentation?: 'reader' | 'search'
  annotationVersionId?: string
  annotationBlockedByHistoricalVersion?: boolean
  annotationVersionPending?: boolean
  activeAnnotations?: readonly Annotation[]
  onAddAnnotation?: (annotation: Annotation) => AnnotationValidationError | undefined
  onUpdateAnnotationNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onRemoveAnnotation?: (id: string) => void
  onUndoAnnotation?: () => boolean
  onRedoAnnotation?: () => boolean
  onAnnotationError?: (error: AnnotationValidationError) => void
  onPdfTranslationChange?: (translation: ActivePdfTranslation | undefined) => void
  onPdfReadingPositionChange?: (position: PdfReadingPosition) => void
  pdfProseRegions?: readonly PdfProseRegion[]
  pdfProseRegionIdentityKey?: string
  onPdfProseRegionsChange?: (regions: readonly PdfProseRegion[]) => void
}

export type PreviewAnnotationPort = Omit<PreviewFileRendererProps, 'item'>

export type PreviewInteractionPort = PreviewAnnotationPort & {
  onLinkReadingContext?: (source: SessionPdfContextSource) => Promise<void>
  onUnlinkReadingContext?: (bindingId: string) => void
}
