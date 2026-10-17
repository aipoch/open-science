import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import type { RunObservationMediaCapture } from '../../../../../shared/run-observation-archive'

export type RecordedProjectImage = {
  id: string
  capture: RunObservationMediaCapture
  publication?: 'published' | 'awaiting-publication'
}

/** One immutable frame is loaded at a time. Multiple captures may share one evidence cursor. */
export const RecordedProjectImages = ({
  images,
  readImage,
  sourceStep
}: {
  images: readonly RecordedProjectImage[]
  readImage: (id: string) => Promise<string | null>
  sourceStep?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [selectedId, setSelectedId] = useState(images[0]?.id)
  const currentIndex = images.findIndex((image) => image.id === selectedId)
  const current = images[currentIndex]
  const present = Boolean(current)
  const [loaded, setLoaded] = useState<{ id: string; src: string | null }>()
  useEffect(() => {
    if (!selectedId || !present) return
    let disposed = false
    void readImage(selectedId).then(
      (src) => {
        if (!disposed) setLoaded({ id: selectedId, src })
      },
      () => {
        if (!disposed) setLoaded({ id: selectedId, src: null })
      }
    )
    return () => {
      disposed = true
    }
  }, [selectedId, present, readImage])
  if (!current) return <ErrorNotice inline title={t('This file preview is unavailable here.')} />
  const ready = loaded?.id === current.id
  return (
    <div className="space-y-2" data-testid="recorded-project-images">
      <p className="text-xs font-medium">
        {t('Recorded project image {{current}} of {{total}}', {
          current: currentIndex + 1,
          total: images.length
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('Captured from {{start}} to {{end}}.', {
          start: new Date(current.capture.startedAt).toISOString(),
          end: new Date(current.capture.finishedAt).toISOString()
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('This is a recorded image, not a live project page.')}
      </p>
      {sourceStep ? (
        <p className="break-words text-xs text-muted-foreground">
          {t('Source step: {{step}}', { step: sourceStep })}
        </p>
      ) : null}
      {current.publication === 'awaiting-publication' ? (
        <p className="text-xs text-status-warning-foreground">
          {t('This captured image is awaiting archive publication.')}
        </p>
      ) : null}
      {images.length > 1 ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={currentIndex === 0}
            onClick={() => setSelectedId(images[currentIndex - 1].id)}
          >
            {t('Previous image')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={currentIndex === images.length - 1}
            onClick={() => setSelectedId(images[currentIndex + 1].id)}
          >
            {t('Next image')}
          </Button>
        </div>
      ) : null}
      {!ready ? (
        <p role="status" className="text-sm">
          {t('Preparing recorded material…')}
        </p>
      ) : loaded.src ? (
        <img
          src={loaded.src}
          alt={t('Recorded project image')}
          className="max-h-[70vh] max-w-full object-contain"
        />
      ) : (
        <ErrorNotice inline title={t('Could not read the recorded material.')} />
      )}
    </div>
  )
}
