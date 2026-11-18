import { MessageSquarePlus } from 'lucide-react'
import { useLayoutEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import type { Annotation, PptSlideAnnotation } from '../../../../../shared/annotation-contract'
import type { AnnotationValidationError } from '../../../../../shared/annotations'
import type { OfficePreviewSlideView } from '../../../../../shared/office-preview'
import {
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation
} from '../annotations/annotation-reveal'
import { pptxAnnotationSourceForPreview } from '../annotations/pptx-annotation-source'
import {
  buildSlideAnnotation,
  isSlideAnnotation,
  sameDeckVersion,
  slideAnnotationsFor
} from '../annotations/pptx-slide-annotation'
import { PptxSlideAnnotationLayer, type SlidePick } from './PptxSlideAnnotationLayer'
import { PptxSlideNoteEditor } from './PptxSlideNoteEditor'
import { OfficePreviewContent, type OfficeSlideRequest } from './renderers/OfficePreview'
import { usePptxOutline } from './use-pptx-outline'

type PptxSlideAnnotationSurfaceProps = {
  item: PreviewFileItem
  activeAnnotations: readonly Annotation[]
  disabled: boolean
  onAdd: (annotation: PptSlideAnnotation) => AnnotationValidationError | undefined
  onAnnotationError?: (error: AnnotationValidationError) => void
}

const PptxSlideAnnotationSurface = ({
  item,
  activeAnnotations,
  disabled,
  onAdd,
  onAnnotationError
}: PptxSlideAnnotationSurfaceProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [slideView, setSlideView] = useState<OfficePreviewSlideView>()
  const [annotating, setAnnotating] = useState(false)
  const [pick, setPick] = useState<SlidePick>()
  const [revealed, setRevealed] = useState<PptSlideAnnotation>()
  const [slideRequest, setSlideRequest] = useState<OfficeSlideRequest>()
  const source = useMemo(() => pptxAnnotationSourceForPreview(item), [item])
  const identity = useMemo(
    () =>
      item.projectId && item.managedFileId && (item.source === 'upload' || source)
        ? {
            source: item.source === 'upload' ? ('upload' as const) : ('artifact' as const),
            projectId: item.projectId,
            fileId: item.managedFileId
          }
        : undefined,
    [item.managedFileId, item.projectId, item.source, source]
  )
  // A reveal needs marker geometry even where new annotations are blocked, e.g. on an old version.
  const outline = usePptxOutline(
    identity,
    source?.versionId,
    source !== undefined && (!disabled || revealed !== undefined)
  )
  const slideIndex = slideView?.slideIndex ?? 0
  const slide = outline?.slides[slideIndex]
  const markers = useMemo(() => {
    if (!slide) return []
    const active = slideAnnotationsFor(activeAnnotations, source, slide.slideId)
    // A sent annotation is no longer in the draft, so its reveal adds a marker of its own.
    const extra =
      revealed &&
      revealed.slideId === slide.slideId &&
      sameDeckVersion(revealed, source) &&
      !active.some((annotation) => annotation.id === revealed.id)
        ? [revealed]
        : []
    return [...active, ...extra].map((annotation, index) => ({
      id: annotation.id,
      number: index < active.length ? index + 1 : 1,
      shapeId: annotation.shapeId,
      region: annotation.region
    }))
  }, [activeAnnotations, revealed, slide, source])

  // Version-pinned annotations keep a valid slideIndex, so the jump does not wait for the outline.
  useLayoutEffect(() => {
    let prepared: PptSlideAnnotation | undefined
    const stopPreparation = subscribeAnnotationRevealPreparation((annotation) => {
      prepared =
        isSlideAnnotation(annotation) && sameDeckVersion(annotation, source)
          ? annotation
          : undefined
    })
    const stopReveal = subscribeAnnotationReveal((annotationId) => {
      const annotation =
        activeAnnotations
          .filter(isSlideAnnotation)
          .find((entry) => entry.id === annotationId && sameDeckVersion(entry, source)) ??
        (prepared?.id === annotationId ? prepared : undefined)
      if (!annotation) return false
      setRevealed(annotation)
      setAnnotating(false)
      setPick(undefined)
      setSlideRequest((current) => ({
        slideIndex: annotation.slideIndex,
        serial: (current?.serial ?? 0) + 1
      }))
      return true
    })
    return () => {
      stopPreparation()
      stopReveal()
    }
  }, [activeAnnotations, source])

  const submit = (note: string): void => {
    if (!source || !slide || !pick) return
    const error = onAdd(
      buildSlideAnnotation(source, { slideId: slide.slideId, slideIndex, ...pick }, note)
    )
    if (error) return onAnnotationError?.(error)
    setPick(undefined)
    setAnnotating(false)
  }
  const canAnnotate = !disabled && source !== undefined && outline !== undefined

  return (
    <div className="flex size-full flex-col">
      {canAnnotate ? (
        <Button
          type="button"
          variant={annotating ? 'default' : 'secondary'}
          size="sm"
          aria-pressed={annotating}
          className="my-1 mr-3 shrink-0 self-end"
          onClick={() => {
            setAnnotating(!annotating)
            setPick(undefined)
            setRevealed(undefined)
          }}
        >
          <MessageSquarePlus aria-hidden="true" />
          {t('Annotate slide')}
        </Button>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <OfficePreviewContent
          item={item}
          source={item.source}
          slideRequest={slideRequest}
          onSlideView={setSlideView}
        />
        {outline ? (
          <PptxSlideAnnotationLayer
            outline={outline}
            slideIndex={slideIndex}
            slideView={slideView}
            markers={markers}
            revealedId={revealed?.id}
            active={annotating && !pick}
            disabled={!canAnnotate}
            onPick={setPick}
          />
        ) : null}
        {pick ? (
          <PptxSlideNoteEditor onSubmit={submit} onCancel={() => setPick(undefined)} />
        ) : null}
      </div>
    </div>
  )
}

export { PptxSlideAnnotationSurface }
