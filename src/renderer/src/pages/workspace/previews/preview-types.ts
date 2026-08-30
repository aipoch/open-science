import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { Annotation, AnnotationValidationError } from '../../../../../shared/annotations'
import type {
  PdfReadingPosition,
  SessionPdfContextSource
} from '../../../../../shared/session-persistence'

export type PreviewFileRendererProps = {
  item: PreviewFileItem
  activeAnnotations?: readonly Annotation[]
  onAddAnnotation?: (annotation: Annotation) => AnnotationValidationError | undefined
  onUpdateAnnotationNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onRemoveAnnotation?: (id: string) => void
  onUndoAnnotation?: () => boolean
  onRedoAnnotation?: () => boolean
  onAnnotationError?: (error: AnnotationValidationError) => void
  onPdfReadingPositionChange?: (position: PdfReadingPosition) => void
}

export type PreviewAnnotationPort = Omit<PreviewFileRendererProps, 'item'>

export type PreviewInteractionPort = PreviewAnnotationPort & {
  onLinkReadingContext?: (source: SessionPdfContextSource) => Promise<void>
  onUnlinkReadingContext?: (bindingId: string) => void
}
