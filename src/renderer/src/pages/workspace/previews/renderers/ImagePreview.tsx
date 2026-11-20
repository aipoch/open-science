import { imagePointAnnotationSourceForPreview } from '../../annotations/image-annotation-source'
import { ImageEditEntry } from '../../image-edit/ImageEditEntry'
import type { ImageEditorDraft } from '../../image-edit/image-editor-state'
import { ImageEditorBoundary } from '../../image-edit/ImageEditor'
import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-contract'
import { ImageOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Annotation } from '../../../../../../shared/annotation-contract'
import type { AnnotationValidationError } from '../../../../../../shared/annotations'
import { ImagePointAnnotationSurface } from '../../annotations/ImagePointAnnotationSurface'
import type { PreviewFileRendererProps } from '../preview-types'
import { PreviewErrorCard, PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import { useCachedPreviewImage } from '../useCachedPreviewImage'
import { usePreviewResourceKey } from '../usePreviewResourceGeneration'
import { ZoomablePreview } from './ZoomablePreview'

const ZoomableImage = ({
  url,
  name,
  onError,
  sourceSize,
  annotationItem,
  activeAnnotations = [],
  onAddAnnotation,
  onUpdateAnnotationNote,
  onRemoveAnnotation,
  onAnnotationError,
  initialTransform,
  onTransformEnd,
  onEdit,
  editDisabledReason,
  annotationRequiresAlt
}: {
  url: string
  name: string
  onError: () => void
  sourceSize?: { width: number; height: number }
  annotationItem?: PreviewFileItem
  activeAnnotations?: readonly Annotation[]
  onAddAnnotation?: (annotation: Annotation) => AnnotationValidationError | undefined
  onUpdateAnnotationNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onRemoveAnnotation?: (id: string) => void
  onAnnotationError?: (error: AnnotationValidationError) => void
  initialTransform?: ImageEditorDraft['zoom']
  onEdit?: () => void
  annotationRequiresAlt?: boolean
  editDisabledReason?: string
  onTransformEnd?: (zoom: NonNullable<ImageEditorDraft['zoom']>) => void
}): React.JSX.Element => {
  return (
    <ZoomablePreview
      cursorMode="grab-when-zoomed"
      initialTransform={initialTransform}
      onTransformEnd={onTransformEnd}
    >
      <ImageEditEntry
        onEdit={onEdit}
        disabledReason={editDisabledReason}
        sourceSize={sourceSize}
        canAnnotate={Boolean(
          onAddAnnotation && annotationItem && imagePointAnnotationSourceForPreview(annotationItem)
        )}
      >
        {annotationItem ? (
          <ImagePointAnnotationSurface
            item={annotationItem}
            src={url}
            sourceSize={sourceSize}
            activeAnnotations={activeAnnotations}
            requireAltToAdd={annotationRequiresAlt}
            onAdd={onAddAnnotation}
            onUpdateNote={onUpdateAnnotationNote}
            onRemove={onRemoveAnnotation}
            onAnnotationError={onAnnotationError}
            onImageError={onError}
          />
        ) : (
          <img
            src={url}
            alt={name}
            className="size-full object-contain"
            draggable={false}
            onError={onError}
          />
        )}
      </ImageEditEntry>
    </ZoomablePreview>
  )
}

export const PreviewImageContent = ({
  path,
  name,
  source = 'artifact',
  projectId,
  sessionId,
  managedFileId,
  selectedVersionId,
  mimeType,
  size,
  mtimeMs,
  annotationItem,
  activeAnnotations,
  onAddAnnotation,
  onUpdateAnnotationNote,
  onRemoveAnnotation,
  onAnnotationError,
  initialTransform,
  onTransformEnd,
  onEdit,
  editDisabledReason,
  annotationRequiresAlt
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  managedFileId?: string
  selectedVersionId?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  annotationItem?: PreviewFileItem
  activeAnnotations?: readonly Annotation[]
  onAddAnnotation?: (annotation: Annotation) => AnnotationValidationError | undefined
  onUpdateAnnotationNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onRemoveAnnotation?: (id: string) => void
  onAnnotationError?: (error: AnnotationValidationError) => void
  initialTransform?: ImageEditorDraft['zoom']
  onEdit?: () => void
  annotationRequiresAlt?: boolean
  editDisabledReason?: string
  onTransformEnd?: (zoom: NonNullable<ImageEditorDraft['zoom']>) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const requestKey = usePreviewResourceKey({
    projectId,
    sessionId,
    source,
    path,
    managedFileId,
    selectedVersionId,
    mimeType,
    size,
    mtimeMs
  })
  const [failedRequestKey, setFailedRequestKey] = useState<string | undefined>(undefined)
  const hasFailed = failedRequestKey === requestKey
  // A decode failure disables the hook, which releases the protocol capability immediately.
  const state = useCachedPreviewImage(
    {
      projectId,
      sessionId,
      managedFileId,
      selectedVersionId,
      path,
      source,
      mimeType,
      size,
      mtimeMs
    },
    !hasFailed,
    hasFailed
  )

  if (state.status === 'loading') return <PreviewLoadingContent />

  // Acquisition errors preserve the upstream missing/outside-storage distinction.
  if (state.status === 'error') {
    return (
      <PreviewErrorCard
        name={name}
        error={state.error}
        fallbackMessage={t("Image couldn't be loaded for preview")}
      />
    )
  }

  if (state.status === 'idle' || hasFailed) {
    return (
      <PreviewFallbackCard
        icon={ImageOff}
        name={name}
        message={t(
          'The browser could not display this image. It may be damaged, unsupported, or exceed available memory. Download the original to view it.'
        )}
        retryable
      />
    )
  }

  return (
    <div className="relative size-full overflow-hidden p-4">
      <ZoomableImage
        onEdit={onEdit}
        editDisabledReason={editDisabledReason}
        initialTransform={initialTransform}
        onTransformEnd={onTransformEnd}
        annotationRequiresAlt={annotationRequiresAlt}
        url={state.url}
        name={name}
        onError={() => setFailedRequestKey(requestKey)}
        sourceSize={
          state.width && state.height ? { width: state.width, height: state.height } : undefined
        }
        annotationItem={annotationItem}
        activeAnnotations={activeAnnotations}
        onAddAnnotation={onAddAnnotation}
        onUpdateAnnotationNote={onUpdateAnnotationNote}
        onRemoveAnnotation={onRemoveAnnotation}
        onAnnotationError={onAnnotationError}
      />
    </div>
  )
}

export const ImagePreviewRenderer = ({
  item,
  imageEditPresentation = 'panel',
  readOnly,
  onPinImageSource,
  onImageEditorVersionChange,
  activeAnnotations,
  onAddAnnotation,
  onUpdateAnnotationNote,
  onRemoveAnnotation,
  onAnnotationError
}: PreviewFileRendererProps): React.JSX.Element => (
  <ImageEditorBoundary
    item={item}
    presentation={imageEditPresentation}
    readOnly={readOnly}
    onPinSource={onPinImageSource}
    onVersionChange={onImageEditorVersionChange}
  >
    {({ item: previewItem, initialTransform, onTransformEnd, onEdit, editDisabledReason }) => (
      <PreviewImageContent
        onEdit={imageEditPresentation === 'panel' ? onEdit : undefined}
        editDisabledReason={editDisabledReason}
        key={previewItem.selectedVersionId}
        initialTransform={initialTransform}
        onTransformEnd={onTransformEnd}
        path={previewItem.path}
        name={previewItem.name}
        source={previewItem.source}
        projectId={previewItem.projectId}
        sessionId={previewItem.sessionId}
        managedFileId={previewItem.managedFileId}
        selectedVersionId={previewItem.selectedVersionId}
        mimeType={previewItem.mimeType}
        size={previewItem.size}
        mtimeMs={previewItem.mtimeMs}
        annotationItem={
          previewItem.selectedVersionId === item.selectedVersionId ? previewItem : undefined
        }
        activeAnnotations={
          previewItem.selectedVersionId === item.selectedVersionId ? activeAnnotations : []
        }
        annotationRequiresAlt={imageEditPresentation !== 'panel'}
        onAddAnnotation={onAddAnnotation}
        onUpdateAnnotationNote={onUpdateAnnotationNote}
        onRemoveAnnotation={onRemoveAnnotation}
        onAnnotationError={onAnnotationError}
      />
    )}
  </ImageEditorBoundary>
)
