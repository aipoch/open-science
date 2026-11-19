import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronsLeftRight } from 'lucide-react'
import { ErrorNotice } from '@/components/error-notice'
import { createArtifactVersionLocator } from '../../../../../shared/artifact-version-locator'
import { createUploadVersionReference } from '../../../../../shared/uploads'
import type { ImageEditSnapshot } from '../../../../../shared/image-edit-contract'
import { useCachedPreviewImage } from '../previews/useCachedPreviewImage'
import { PreviewLoadingContent } from '../previews/PreviewFallback'
import { ZoomablePreview } from '../previews/renderers/ZoomablePreview'

// Both images share one transform; clipping never rescales either image.
export function ImageEditComparison({
  source,
  resultUrl,
  sourceLabel,
  resultLabel
}: {
  source: ImageEditSnapshot['source']
  resultUrl: string
  sourceLabel?: string
  resultLabel?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const surface = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(50)
  const [decodeError, setDecodeError] = useState(false)
  const input = useCachedPreviewImage({
    source: source.sourceKind === 'upload-version' ? 'upload' : 'artifact',
    path:
      source.sourceKind === 'upload-version'
        ? createUploadVersionReference(source.sourceVersionId, {
            projectId: source.projectId,
            sessionId: source.sourceSessionId,
            fileId: source.sourceFileId
          })
        : createArtifactVersionLocator({
            projectId: source.projectId,
            appSessionId: source.sourceSessionId,
            artifactId: source.sourceFileId,
            versionId: source.sourceVersionId
          }),
    projectId: source.projectId,
    sessionId: source.sourceSessionId,
    managedFileId: source.sourceFileId,
    selectedVersionId: source.sourceVersionId,
    mimeType: source.mimeType
  })
  if (input.status === 'loading') return <PreviewLoadingContent />
  if (input.status !== 'ready' || decodeError)
    return <ErrorNotice inline title={t('Image could not be loaded.')} />
  return (
    <div className="flex size-full min-h-0 min-w-0 flex-col">
      <div
        aria-hidden="true"
        className="pointer-events-none flex shrink-0 select-none items-center justify-between gap-4 px-1 pb-2 text-xs text-text-200"
      >
        <span className="truncate">{sourceLabel ?? t('Before edit')}</span>
        <span className="truncate">{resultLabel ?? t('After edit')}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <ZoomablePreview tooltipClassName="z-[80]" cursorMode="grab-when-zoomed">
          <div
            ref={surface}
            className="relative size-full bg-muted"
            role="group"
            aria-label={t('Image comparison')}
            tabIndex={-1}
          >
            <img
              src={resultUrl}
              alt={resultLabel ?? t('After edit')}
              draggable={false}
              onError={() => setDecodeError(true)}
              className="size-full select-none object-contain"
            />
            <div
              className="pointer-events-none absolute inset-0 bg-muted"
              style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
            >
              <img
                src={input.url}
                alt={sourceLabel ?? t('Before edit')}
                draggable={false}
                onError={() => setDecodeError(true)}
                className="size-full select-none object-contain"
              />
            </div>
            <div
              role="slider"
              aria-label={t('Comparison position')}
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={position}
              tabIndex={0}
              data-preview-escape-boundary
              className="absolute inset-y-0 w-8 -translate-x-1/2 cursor-ew-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ left: `${position}%` }}
              onDoubleClick={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
              onTouchMove={(event) => event.stopPropagation()}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                event.stopPropagation()
                event.currentTarget.focus()
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                event.stopPropagation()
                const rect = surface.current?.getBoundingClientRect()
                if (rect?.width)
                  setPosition(
                    Math.round(
                      Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100))
                    )
                  )
              }}
              onPointerUp={(event) => {
                event.stopPropagation()
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId)
              }}
              onKeyDown={(event) => {
                const delta = event.shiftKey ? 10 : 1
                const next = {
                  ArrowLeft: position - delta,
                  ArrowRight: position + delta,
                  ArrowDown: position - delta,
                  ArrowUp: position + delta,
                  Home: 0,
                  End: 100
                }[event.key]
                if (next === undefined) return
                event.preventDefault()
                event.stopPropagation()
                setPosition(Math.max(0, Math.min(100, next)))
              }}
            >
              <div className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-bg-000 shadow-sm" />
              <div className="pointer-events-none absolute left-1/2 top-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-border-300/50 bg-bg-000 text-text-100 shadow-sm">
                <ChevronsLeftRight className="size-4" />
              </div>
            </div>
          </div>
        </ZoomablePreview>
      </div>
    </div>
  )
}
