import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export type RecordedMediaViewportProps = {
  width?: number
  height?: number
  children?: ReactNode
  status?: ReactNode
  metadata?: ReactNode
  compact?: boolean
  surfaceTestId?: string
}

/** Sizing only. The media adapter owns its source, decoding, clock and evidence identity. */
export function RecordedMediaViewport({
  width,
  height,
  children,
  status,
  metadata,
  compact = false,
  surfaceTestId
}: RecordedMediaViewportProps): React.JSX.Element {
  const { t } = useTranslation()
  const [nativeSize, setNativeSize] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const hasDimensions = Boolean(width && height && width > 0 && height > 0)
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const update = (): void => {
      const next = { width: element.clientWidth, height: element.clientHeight }
      setBounds((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next
      )
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const scale =
    hasDimensions && bounds.width && bounds.height
      ? Math.min(bounds.width / width!, bounds.height / height!)
      : undefined
  const displayWidth = hasDimensions && nativeSize ? width : scale ? width! * scale : '100%'
  const displayHeight = hasDimensions && nativeSize ? height : scale ? height! * scale : '100%'
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      data-testid="recorded-media-viewport"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{metadata}</div>
        <div className="flex shrink-0 gap-1" role="group" aria-label={t('Recorded media size')}>
          {compact ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={!hasDimensions && !nativeSize}
              onClick={() => setNativeSize((value) => !value)}
            >
              {nativeSize ? t('Fit to window') : t('Actual size (100%)')}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant={nativeSize ? 'ghost' : 'secondary'}
                aria-pressed={!nativeSize}
                onClick={() => setNativeSize(false)}
              >
                {t('Fit to window')}
              </Button>
              <Button
                size="sm"
                variant={nativeSize ? 'secondary' : 'ghost'}
                aria-pressed={nativeSize}
                disabled={!hasDimensions}
                onClick={() => setNativeSize(true)}
              >
                {t('Actual size (100%)')}
              </Button>
            </>
          )}
        </div>
      </div>
      <div
        ref={viewport}
        className="relative min-h-0 min-w-0 flex-1 overflow-auto rounded bg-bg-100"
        data-testid="recorded-media-scroll"
        data-size-mode={nativeSize ? 'actual' : 'fit'}
      >
        <div
          className="flex min-h-full min-w-full items-center justify-center"
          style={{
            width: nativeSize ? 'max-content' : '100%',
            height: nativeSize ? 'max-content' : '100%'
          }}
        >
          <div
            className="relative shrink-0"
            style={{
              width: displayWidth,
              height: displayHeight,
              aspectRatio: hasDimensions ? `${width} / ${height}` : undefined
            }}
            data-testid={surfaceTestId}
          >
            {children}
          </div>
        </div>
        {status ? (
          <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-bg-100/80 p-4 text-sm text-muted-foreground">
            {status}
          </div>
        ) : null}
      </div>
    </div>
  )
}
