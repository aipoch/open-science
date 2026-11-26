import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
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
  imageEditPresentation?: 'panel' | 'expanded-panel' | 'dialog'
  onPinImageSource?: () => void
  onImageEditorVersionChange?: (item: PreviewFileItem | undefined) => void
  onImageEditActionChange?: (action: PreviewImageEditAction | undefined) => void
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

export type PreviewImageEditAction = {
  execute: () => void
  disabled?: boolean
}

export type PreviewAnnotationPort = Omit<PreviewFileRendererProps, 'item'>

export type PreviewInteractionPort = PreviewAnnotationPort & {
  onLinkReadingContext?: (source: SessionPdfContextSource) => Promise<void>
  onUnlinkReadingContext?: (bindingId: string) => void
}
