import { Shrink, ZoomIn, ZoomOut } from 'lucide-react'
import { TransformComponent, TransformWrapper, useControls } from 'react-zoom-pan-pinch'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

const PreviewZoomControls = ({ reduceMotion }: { reduceMotion: boolean }): React.JSX.Element => {
  const { zoomIn, zoomOut, resetTransform } = useControls()
  const actions = [
    { label: 'Zoom in', icon: ZoomIn, onClick: () => zoomIn() },
    { label: 'Zoom out', icon: ZoomOut, onClick: () => zoomOut() },
    {
      label: 'Reset zoom',
      icon: Shrink,
      onClick: () => resetTransform(reduceMotion ? 0 : undefined)
    }
  ]

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute bottom-3 right-3 z-10 flex gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-1 shadow-sm backdrop-blur">
        {actions.map(({ label, icon: Icon, onClick }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={label}
                onClick={onClick}
              >
                <Icon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}

const ZoomablePreview = ({ children }: { children: React.ReactNode }): React.JSX.Element => {
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
      <PreviewZoomControls reduceMotion={reduceMotion} />
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
