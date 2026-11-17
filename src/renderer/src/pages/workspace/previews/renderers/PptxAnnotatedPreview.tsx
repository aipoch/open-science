import type { PreviewFileRendererProps } from '../preview-types'
import { PptxSlideAnnotationSurface } from '../PptxSlideAnnotationSurface'
import { OfficePreviewRenderer } from './OfficePreview'

// Only .pptx decks get the slide annotation layer; other Office files keep the plain preview.
const PptxAnnotatedPreviewRenderer = (props: PreviewFileRendererProps): React.JSX.Element => {
  const {
    item,
    readOnly,
    annotationBlockedByHistoricalVersion,
    annotationVersionPending,
    activeAnnotations = [],
    onAddAnnotation,
    onAnnotationError
  } = props
  if (!item.name.toLowerCase().endsWith('.pptx') || !onAddAnnotation) {
    return <OfficePreviewRenderer {...props} />
  }
  return (
    <PptxSlideAnnotationSurface
      item={item}
      activeAnnotations={activeAnnotations}
      disabled={!!readOnly || !!annotationBlockedByHistoricalVersion || !!annotationVersionPending}
      onAdd={(annotation) => onAddAnnotation(annotation)}
      onAnnotationError={onAnnotationError}
    />
  )
}

export { PptxAnnotatedPreviewRenderer }
