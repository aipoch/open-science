import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type {
  Annotation,
  AnnotationValidationError,
  ImagePointAnnotation
} from '../../../../../shared/annotations'

import {
  fitContainedImageRect,
  viewportPointToNormalized,
  type ImageAnnotationPoint,
  type ImageAnnotationRect,
  type ImageNaturalSize
} from './image-annotation-geometry'
import {
  imagePointAnnotationSourceForPreview,
  type ImagePointAnnotationSource
} from './image-annotation-source'
import { createAnnotationId } from './annotation-id'
import { subscribeAnnotationReveal } from './annotation-reveal'
import { useAnnotationSurfaceScale } from './use-annotation-surface-scale'

const IMAGE_POINT_CLICK_THRESHOLD = 4

type PointerStart = ImageAnnotationPoint & Readonly<{ pointerId: number }>

type PendingPoint = Readonly<{
  point: ImageAnnotationPoint
  source: ImagePointAnnotationSource
  naturalSize: ImageNaturalSize
  annotationId?: string
  number?: number
}>

const sameImageVersion = (
  annotation: ImagePointAnnotation,
  source: ImagePointAnnotationSource | undefined
): boolean =>
  !!source &&
  annotation.source.kind === source.kind &&
  annotation.source.projectId === source.projectId &&
  annotation.source.sessionId === source.sessionId &&
  annotation.source.versionId === source.versionId

const ImagePointAnnotationSurface = ({
  item,
  src,
  activeAnnotations,
  onAdd,
  onUpdateNote,
  onRemove,
  onAnnotationError,
  onImageError
}: {
  item: PreviewFileItem
  src: string
  activeAnnotations: readonly Annotation[]
  onAdd?: (annotation: ImagePointAnnotation) => AnnotationValidationError | undefined
  onUpdateNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onRemove?: (id: string) => void
  onAnnotationError?: (error: AnnotationValidationError) => void
  onImageError: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const surfaceScale = useAnnotationSurfaceScale()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const focusReturnRef = useRef<HTMLElement | null>(null)
  const pointerStart = useRef<PointerStart | undefined>(undefined)
  const [naturalSize, setNaturalSize] = useState<ImageNaturalSize>()
  const [localContentRect, setLocalContentRect] = useState<ImageAnnotationRect>()
  const [pending, setPending] = useState<PendingPoint>()
  const [pendingMode, setPendingMode] = useState<'preview' | 'edit'>('edit')
  const [note, setNote] = useState('')
  const [noteRequired, setNoteRequired] = useState(false)
  const source = useMemo(() => imagePointAnnotationSourceForPreview(item), [item])
  const numberedImageAnnotations = useMemo(
    () =>
      activeAnnotations
        .filter(
          (annotation): annotation is ImagePointAnnotation => annotation.kind === 'image-point'
        )
        .map((annotation, index) => ({ annotation, number: index + 1 })),
    [activeAnnotations]
  )
  const visibleAnnotations = numberedImageAnnotations.filter(({ annotation }) =>
    sameImageVersion(annotation, source)
  )
  const pendingNumber = numberedImageAnnotations.length + 1
  const displayNumber = pending?.number ?? pendingNumber

  useEffect(
    () =>
      subscribeAnnotationReveal((annotationId) => {
        const match = visibleAnnotations.find(({ annotation }) => annotation.id === annotationId)
        if (!match) return false
        focusReturnRef.current = surfaceRef.current
        setPending({
          annotationId: match.annotation.id,
          number: match.number,
          point: match.annotation.point,
          source: match.annotation.source,
          naturalSize: match.annotation.naturalSize
        })
        setNote(match.annotation.note)
        setNoteRequired(false)
        setPendingMode('preview')
        return true
      }),
    [visibleAnnotations]
  )

  const clearPending = (): void => {
    const focusReturn = focusReturnRef.current
    focusReturnRef.current = null
    setPending(undefined)
    setPendingMode('edit')
    setNote('')
    setNoteRequired(false)
    queueMicrotask(() => (focusReturn?.isConnected ? focusReturn : surfaceRef.current)?.focus())
  }

  const measureLocalContent = (size: ImageNaturalSize): void => {
    const surface = surfaceRef.current
    if (!surface) return
    setLocalContentRect(
      fitContainedImageRect(
        { left: 0, top: 0, width: surface.clientWidth, height: surface.clientHeight },
        size
      )
    )
  }

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || !naturalSize || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measureLocalContent(naturalSize))
    observer.observe(surface)
    return () => observer.disconnect()
  }, [naturalSize])

  const capturePoint = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = pointerStart.current
    pointerStart.current = undefined
    if (
      !start ||
      start.pointerId !== event.pointerId ||
      event.button !== 0 ||
      event.isPrimary === false ||
      !naturalSize ||
      !source ||
      !onAdd
    ) {
      return
    }
    if (
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > IMAGE_POINT_CLICK_THRESHOLD
    ) {
      return
    }
    const surface = surfaceRef.current
    if (!surface) return
    const rect = surface.getBoundingClientRect()
    const imageRect = fitContainedImageRect(rect, naturalSize)
    if (!imageRect) return
    const point = viewportPointToNormalized({ x: event.clientX, y: event.clientY }, imageRect)
    if (!point) return
    focusReturnRef.current = surface
    setPending({ point, source, naturalSize })
    setPendingMode('edit')
    setNote('')
    setNoteRequired(false)
  }

  const addPending = (): void => {
    const trimmedNote = note.trim()
    if (!pending || (!onAdd && !pending.annotationId)) return
    if (!trimmedNote) {
      setNoteRequired(true)
      return
    }
    const error = pending.annotationId
      ? onUpdateNote?.(pending.annotationId, trimmedNote)
      : onAdd?.({
          id: createAnnotationId(),
          kind: 'image-point',
          target: 'agent',
          note: trimmedNote,
          source: pending.source,
          point: pending.point,
          naturalSize: pending.naturalSize
        })
    if (error) {
      onAnnotationError?.(error)
      return
    }
    clearPending()
  }

  const markerStyle = (
    point: ImageAnnotationPoint,
    rect: ImageAnnotationRect | undefined,
    scale: number
  ): React.CSSProperties | undefined =>
    rect
      ? {
          left: rect.left + point.x * rect.width,
          top: rect.top + point.y * rect.height,
          // The zoom wrapper scales the whole surface; the marker counters
          // so its on-screen size stays constant while staying pinned to
          // the image point.
          transform: `translate(-50%, -50%) scale(${1 / scale})`
        }
      : undefined

  return (
    <div
      ref={surfaceRef}
      data-image-annotation-surface="true"
      className="relative size-full touch-none outline-none"
      tabIndex={-1}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          event.isPrimary === false ||
          !naturalSize ||
          !source ||
          !onAdd ||
          (event.target instanceof Element && event.target.closest('button'))
        ) {
          return
        }
        const surface = surfaceRef.current
        if (!surface) return
        const imageRect = fitContainedImageRect(surface.getBoundingClientRect(), naturalSize)
        if (
          !imageRect ||
          !viewportPointToNormalized({ x: event.clientX, y: event.clientY }, imageRect)
        ) {
          return
        }
        pointerStart.current = {
          x: event.clientX,
          y: event.clientY,
          pointerId: event.pointerId
        }
      }}
      onPointerCancel={() => {
        pointerStart.current = undefined
      }}
      onPointerUp={capturePoint}
    >
      <img
        src={src}
        alt={item.name}
        className="size-full object-contain"
        draggable={false}
        onLoad={(event) => {
          const nextSize = {
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight
          }
          if (nextSize.width <= 0 || nextSize.height <= 0) return
          setNaturalSize(nextSize)
          measureLocalContent(nextSize)
        }}
        onError={onImageError}
      />
      {visibleAnnotations.map(({ annotation, number }) => (
        <button
          type="button"
          key={annotation.id}
          className="absolute z-[1] flex size-6 items-center justify-center rounded-full border-2 border-primary-foreground bg-primary text-[11px] font-bold text-primary-foreground shadow outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          style={markerStyle(annotation.point, localContentRect, surfaceScale)}
          aria-label={t('Point {{number}} at {{x}}, {{y}}', {
            number,
            x: annotation.point.x.toFixed(3),
            y: annotation.point.y.toFixed(3)
          })}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            focusReturnRef.current = event.currentTarget
            setPending({
              annotationId: annotation.id,
              number,
              point: annotation.point,
              source: annotation.source,
              naturalSize: annotation.naturalSize
            })
            setPendingMode('preview')
            setNote(annotation.note)
            setNoteRequired(false)
          }}
        >
          {number}
        </button>
      ))}
      {pending ? (
        <Popover open onOpenChange={(open) => !open && clearPending()}>
          <PopoverAnchor asChild>
            <span
              className="pointer-events-none absolute z-[2] flex size-7 items-center justify-center rounded-full border-2 border-dashed border-primary bg-background text-xs font-bold text-primary shadow"
              style={markerStyle(pending.point, localContentRect, surfaceScale)}
              aria-hidden="true"
            >
              {displayNumber}
            </span>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            side="bottom"
            collisionPadding={8}
            // Preview dialogs and the expanded workbench surface sit at z-[60]/z-[61]. Radix
            // portals this editor to document.body, so it needs the shared floating-layer tier or
            // only the pending point remains visible in full-screen previews.
            className="z-[70] w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground"
            onOpenAutoFocus={(event) => {
              if (pendingMode === 'preview') return
              // Textarea autoFocus owns the useful first focus target.
              event.preventDefault()
              queueMicrotask(() =>
                document.querySelector<HTMLTextAreaElement>('[data-image-annotation-note]')?.focus()
              )
            }}
          >
            <div className="text-xs font-semibold">
              {t('Image point {{number}}', { number: displayNumber })}
            </div>
            {pendingMode === 'preview' ? (
              <p data-image-annotation-preview="true" className="whitespace-pre-wrap text-sm">
                {note}
              </p>
            ) : (
              <>
                <Textarea
                  data-image-annotation-note="true"
                  aria-label={t('Annotation note')}
                  autoFocus
                  value={note}
                  maxLength={2_000}
                  aria-invalid={noteRequired}
                  aria-describedby={noteRequired ? 'image-annotation-note-error' : undefined}
                  placeholder={t('Add context for the Agent')}
                  onChange={(event) => {
                    setNote(event.target.value)
                    if (event.target.value.trim()) setNoteRequired(false)
                  }}
                />
                {noteRequired ? (
                  <p
                    id="image-annotation-note-error"
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {t('Add a note for this image annotation')}
                  </p>
                ) : null}
              </>
            )}
            <div className="flex justify-end gap-2">
              {pendingMode === 'preview' && pending.annotationId && onRemove ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (!pending.annotationId) return
                    onRemove(pending.annotationId)
                    clearPending()
                  }}
                >
                  {t('Delete')}
                </Button>
              ) : null}
              {pendingMode === 'preview' ? (
                <Button type="button" size="sm" onClick={() => setPendingMode('edit')}>
                  {t('Edit')}
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (pending.annotationId) {
                        setNote(
                          visibleAnnotations.find(
                            ({ annotation }) => annotation.id === pending.annotationId
                          )?.annotation.note ?? ''
                        )
                        setPendingMode('preview')
                        setNoteRequired(false)
                      } else clearPending()
                    }}
                  >
                    {t('Cancel')}
                  </Button>
                  <Button type="button" size="sm" onClick={addPending}>
                    {pending.annotationId ? t('Save') : t('Annotate')}
                  </Button>
                </>
              )}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}

export { ImagePointAnnotationSurface, IMAGE_POINT_CLICK_THRESHOLD }
