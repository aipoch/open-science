import type { AnnotationValidationError, TextAnnotation } from '../../../../../shared/annotations'

type AnnotationPort = Readonly<{
  sessionId: string
  activeAnnotations: readonly TextAnnotation[]
  onAdd: (annotation: TextAnnotation) => AnnotationValidationError | undefined
  onRemove?: (id: string) => void
  onUpdateNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onError: (error: AnnotationValidationError) => void
}>

export type { AnnotationPort }
