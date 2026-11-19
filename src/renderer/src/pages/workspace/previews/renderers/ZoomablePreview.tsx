import { useEffect, useRef, useState } from 'react'
import { TransformComponent, TransformWrapper, useControls } from 'react-zoom-pan-pinch'
import type { ReactZoomPanPinchRef } from 'react-zoom-pan-pinch'

import { ZoomControls } from '@/components/ui/zoom-controls'

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

const PreviewZoomControls = ({
  reduceMotion,
  tooltipClassName
}: {
  reduceMotion: boolean
  tooltipClassName?: string
}): React.JSX.Element => {
  const { zoomIn, zoomOut, setTransform } = useControls()
  return (
    <div className="absolute bottom-3 right-3 z-10 flex gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-1 shadow-sm backdrop-blur">
      <ZoomControls
        onZoomIn={() => zoomIn()}
        onZoomOut={() => zoomOut()}
        onReset={() => setTransform(0, 0, 1, reduceMotion ? 0 : undefined)}
        tooltipClassName={tooltipClassName}
      />
    </div>
  )
}

const ZoomablePreview = ({
  children,
  tooltipClassName,
  panningDisabled = false,
  cursorMode = 'grab',
  viewRef,
  initialTransform,
  onTransformEnd
}: {
  children: React.ReactNode
  tooltipClassName?: string
  panningDisabled?: boolean
  cursorMode?: 'grab' | 'crosshair' | 'grab-when-zoomed'
  viewRef?: React.Ref<ReactZoomPanPinchRef>
  initialTransform?: { scale: number; positionX: number; positionY: number }
  onTransformEnd?: (state: { scale: number; positionX: number; positionY: number }) => void
}): React.JSX.Element => {
  const reduceMotion = prefersReducedMotion()
  const [zoomed, setZoomed] = useState((initialTransform?.scale ?? 1) > 1)
  const callback = useRef(onTransformEnd)
  useEffect(() => {
    callback.current = onTransformEnd
  }, [onTransformEnd])
  const pending = useRef<{ scale: number; positionX: number; positionY: number } | undefined>(
    undefined
  )
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flush = (): void => {
    clearTimeout(timer.current)
    if (pending.current) callback.current?.(pending.current)
    pending.current = undefined
  }
  useEffect(() => () => flush(), [])
  const cursorClass =
    cursorMode === 'crosshair'
      ? 'cursor-crosshair'
      : cursorMode === 'grab-when-zoomed' && !zoomed
        ? 'cursor-default'
        : 'cursor-grab active:cursor-grabbing'

  return (
    <TransformWrapper
      ref={viewRef}
      onInit={(ref) => {
        if (initialTransform)
          ref.setTransform(
            initialTransform.positionX,
            initialTransform.positionY,
            initialTransform.scale,
            0
          )
      }}
      onTransform={({ state }) => {
        if (cursorMode === 'grab-when-zoomed' && zoomed !== state.scale > 1)
          setZoomed(state.scale > 1)
        if (!callback.current) return
        pending.current = {
          scale: state.scale,
          positionX: state.positionX,
          positionY: state.positionY
        }
        clearTimeout(timer.current)
        timer.current = setTimeout(flush, 120)
      }}
      minScale={1}
      maxScale={8}
      centerOnInit={!initialTransform}
      zoomAnimation={{ disabled: reduceMotion }}
      doubleClick={{
        disabled: panningDisabled,
        mode: 'reset',
        animationTime: reduceMotion ? 0 : undefined
      }}
      wheel={{
        step: 0.2,
        activationKeys: (keys) => keys.includes('Control') || keys.includes('Meta')
      }}
      panning={{ velocityDisabled: true, disabled: panningDisabled }}
    >
      <PreviewZoomControls reduceMotion={reduceMotion} tooltipClassName={tooltipClassName} />
      <TransformComponent wrapperClass={`!size-full ${cursorClass}`} contentClass="!size-full">
        {children}
      </TransformComponent>
    </TransformWrapper>
  )
}

export { ZoomablePreview }
