import { TransformComponent, TransformWrapper, useControls } from 'react-zoom-pan-pinch'

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
  const { zoomIn, zoomOut, resetTransform } = useControls()
  return (
    <div className="absolute bottom-3 right-3 z-10 flex gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-1 shadow-sm backdrop-blur">
      <ZoomControls
        onZoomIn={() => zoomIn()}
        onZoomOut={() => zoomOut()}
        onReset={() => resetTransform(reduceMotion ? 0 : undefined)}
        tooltipClassName={tooltipClassName}
      />
    </div>
  )
}

const ZoomablePreview = ({
  children,
  tooltipClassName
}: {
  children: React.ReactNode
  tooltipClassName?: string
}): React.JSX.Element => {
  const reduceMotion = prefersReducedMotion()

  return (
    <TransformWrapper
      minScale={1}
      maxScale={8}
      centerOnInit
      zoomAnimation={{ disabled: reduceMotion }}
      doubleClick={reduceMotion ? { mode: 'reset', animationTime: 0 } : { mode: 'reset' }}
      wheel={{
        step: 0.2,
        activationKeys: (keys) => keys.includes('Control') || keys.includes('Meta')
      }}
      panning={{ velocityDisabled: true }}
    >
      <PreviewZoomControls reduceMotion={reduceMotion} tooltipClassName={tooltipClassName} />
      <TransformComponent
        wrapperClass="!size-full cursor-grab active:cursor-grabbing"
        contentClass="!size-full"
      >
        {children}
      </TransformComponent>
    </TransformWrapper>
  )
}

export { ZoomablePreview }
