import type {
  Annotation,
  PdfNormalizedRect,
  PptSlideAnnotation
} from '../../../../../shared/annotation-contract'
import { createAnnotationId } from './annotation-id'
import type { PptxAnnotationSource } from './pptx-annotation-source'

type SlideTarget = Readonly<{
  slideId: number
  slideIndex: number
  shapeId?: number
  region?: PdfNormalizedRect
}>

const isSlideAnnotation = (annotation: Annotation): annotation is PptSlideAnnotation =>
  annotation.kind === 'pptx-slide'

const sameDeckVersion = (
  annotation: PptSlideAnnotation,
  source: PptxAnnotationSource | undefined
): boolean =>
  !!source &&
  annotation.source.kind === source.kind &&
  annotation.source.projectId === source.projectId &&
  annotation.source.sessionId === source.sessionId &&
  annotation.source.versionId === source.versionId

// Annotations of this deck version on one slide, in draft order (numbering is 1-based).
const slideAnnotationsFor = (
  annotations: readonly Annotation[],
  source: PptxAnnotationSource | undefined,
  slideId: number
): readonly PptSlideAnnotation[] =>
  annotations
    .filter(isSlideAnnotation)
    .filter((annotation) => sameDeckVersion(annotation, source) && annotation.slideId === slideId)

const buildSlideAnnotation = (
  source: PptxAnnotationSource,
  target: SlideTarget,
  note: string
): PptSlideAnnotation => ({
  id: createAnnotationId(),
  kind: 'pptx-slide',
  target: 'agent',
  note: note.trim(),
  source,
  slideId: target.slideId,
  slideIndex: target.slideIndex,
  ...(target.shapeId !== undefined ? { shapeId: target.shapeId } : {}),
  ...(target.region ? { region: target.region } : {})
})

export { buildSlideAnnotation, isSlideAnnotation, sameDeckVersion, slideAnnotationsFor }
export type { SlideTarget }
