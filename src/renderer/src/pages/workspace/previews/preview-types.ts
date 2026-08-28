import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { Annotation, AnnotationValidationError } from '../../../../../shared/annotations'

export type PreviewFileRendererProps = {
  item: PreviewFileItem
  activeAnnotations?: readonly Annotation[]
  onAddAnnotation?: (annotation: Annotation) => AnnotationValidationError | undefined
  onUpdateAnnotationNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onRemoveAnnotation?: (id: string) => void
  onAnnotationError?: (error: AnnotationValidationError) => void
}

export type PreviewAnnotationPort = Omit<PreviewFileRendererProps, 'item'>
