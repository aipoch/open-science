import { ImageOff, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { useState } from 'react'
import { TransformComponent, TransformWrapper, useControls } from 'react-zoom-pan-pinch'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import { createPreviewResourceKey } from '../preview-resource-key'
import type { PreviewFileRendererProps } from '../preview-types'
import { useManagedPreviewResource } from '../useManagedPreviewResource'

// Honour the OS "reduce motion" setting the same way the rest of the app does: matchMedia is
// optional (absent under jsdom), so guard the call. Read at render time — the preview remounts
// each time it opens, so there's no long-lived subscription to keep in sync.
const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

// Overlay giving zoom/pan its discoverable, keyboard- and touch-accessible surface: the wheel and
// pinch gestures are invisible affordances, so these buttons expose the same zoom-in/out/reset
// actions for users who never try the modifier gestures.
// useControls reads the TransformWrapper context, so this must render inside <TransformWrapper>.
// zoomIn/zoomOut honour the wrapper's zoomAnimation.disabled, but resetTransform takes its own
// animationTime, so reduce-motion must be passed through here to keep the reset instant too.
const ImageZoomControls = ({ reduceMotion }: { reduceMotion: boolean }): React.JSX.Element => {
  const { zoomIn, zoomOut, resetTransform } = useControls()
  const actions = [
    { label: 'Zoom in', icon: ZoomIn, onClick: () => zoomIn() },
    { label: 'Zoom out', icon: ZoomOut, onClick: () => zoomOut() },
    {
      label: 'Reset zoom',
      icon: Maximize2,
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

// Wraps the managed-resource <img> in a zoom/pan surface for inspecting high-resolution figures.
// scale=1 keeps the object-contain fit-to-window baseline; zoom scales up from there, drag pans
// once zoomed in, and double-click resets to fit. Plain scroll is left to the panel — only
// Ctrl/Cmd+wheel or a trackpad pinch zooms — so scrolling a long preview list never zooms by
// accident. The onError bubbles up unchanged so the existing decode-failure fallback still fires.
const ZoomableImage = ({
  url,
  name,
  onError
}: {
  url: string
  name: string
  onError: () => void
}): React.JSX.Element => {
  // Read once per mount and thread through every animated path (wheel is already instant; buttons
  // read zoomAnimation.disabled; double-click and reset carry their own animationTime).
  const reduceMotion = prefersReducedMotion()

  return (
    <TransformWrapper
      // scale=1 is the fit-to-window baseline; 8x inspects pixel detail without running off-bounds.
      minScale={1}
      maxScale={8}
      centerOnInit
      zoomAnimation={{ disabled: reduceMotion }}
      // Only override animationTime when reducing motion; passing undefined would clobber the
      // library's 200ms default (createSetup copies undefined), leaving animate() with NaN timing.
      doubleClick={reduceMotion ? { mode: 'reset', animationTime: 0 } : { mode: 'reset' }}
      // Function form gives Control-OR-Meta; the array form ANDs its keys, requiring both at once.
      // Trackpad pinch arrives as a wheel event with ctrlKey set, so it passes without a real key.
      wheel={{
        step: 0.2,
        activationKeys: (keys) => keys.includes('Control') || keys.includes('Meta')
      }}
      panning={{ velocityDisabled: true }}
    >
      <ImageZoomControls reduceMotion={reduceMotion} />
      <TransformComponent
        wrapperClass="!size-full cursor-grab active:cursor-grabbing"
        contentClass="!size-full"
      >
        <img
          src={url}
          alt={name}
          className="size-full object-contain"
          draggable={false}
          onError={onError}
        />
      </TransformComponent>
    </TransformWrapper>
  )
}

export const PreviewImageContent = ({
  path,
  name,
  source = 'artifact',
  mimeType,
  size,
  mtimeMs
}: {
  path: string
  name: string
  source?: PreviewFileSource
  mimeType?: string
  size?: number
  mtimeMs?: number
}): React.JSX.Element => {
  const requestKey = createPreviewResourceKey({ source, path, mimeType, size, mtimeMs })
  const [failedRequestKey, setFailedRequestKey] = useState<string | undefined>(undefined)
  const hasFailed = failedRequestKey === requestKey
  // A decode failure disables the hook, which releases the protocol capability immediately.
  const state = useManagedPreviewResource({ path, source, mimeType, size, mtimeMs }, !hasFailed)

  if (state.status === 'loading') return <PreviewLoadingContent />

  // Acquisition errors preserve the upstream missing/outside-storage distinction.
  if (state.status === 'error') {
    return (
      <PreviewErrorCard
        path={path}
        name={name}
        source={source}
        error={state.error}
        fallbackMessage="Image couldn't be loaded for preview"
      />
    )
  }

  if (state.status === 'idle' || hasFailed) {
    return (
      <PreviewFallbackCard
        icon={ImageOff}
        path={path}
        name={name}
        source={source}
        message="Image couldn't be loaded for preview"
      />
    )
  }

  return (
    <div className="relative size-full overflow-hidden p-4">
      <ZoomableImage
        url={state.resource.url}
        name={name}
        onError={() => setFailedRequestKey(requestKey)}
      />
    </div>
  )
}

export const ImagePreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PreviewImageContent
    path={item.path}
    name={item.name}
    source={item.source}
    mimeType={item.mimeType}
    size={item.size}
    mtimeMs={item.mtimeMs}
  />
)
