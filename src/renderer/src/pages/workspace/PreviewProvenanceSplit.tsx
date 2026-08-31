import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupImperativeHandle } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'

// Keep both panel wrappers stable so changing layout never remounts a resource-owning preview.
export const PreviewProvenanceSplit = ({
  mode,
  children,
  provenance
}: {
  mode: 'content' | 'split' | 'provenance'
  children: ReactNode
  provenance: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const id = useId()
  const contentId = `${id}-content`
  const provenanceId = `${id}-provenance`
  const groupRef = useRef<GroupImperativeHandle>(null)
  const splitSize = useRef(40)
  const split = mode === 'split'

  useLayoutEffect(() => {
    const right = mode === 'provenance' ? 100 : mode === 'split' ? splitSize.current : 0
    groupRef.current?.setLayout({ [contentId]: 100 - right, [provenanceId]: right })
  }, [contentId, mode, provenanceId])

  return (
    <ResizablePanelGroup
      groupRef={groupRef}
      orientation="horizontal"
      data-testid="preview-file-content-region"
      className="min-h-0 flex-1"
      disabled={!split}
      onLayoutChanged={(layout, { isUserInteraction }) => {
        // Persist only completed pointer/keyboard changes, not responsive/programmatic resizing.
        if (split && isUserInteraction) splitSize.current = layout[provenanceId] ?? 40
      }}
    >
      <ResizablePanel
        id={contentId}
        defaultSize="60%"
        minSize={split ? '25%' : mode === 'content' ? '100%' : '0%'}
        maxSize={mode === 'provenance' ? '0%' : '100%'}
        aria-hidden={mode === 'provenance' || undefined}
        inert={mode === 'provenance' || undefined}
      >
        {children}
      </ResizablePanel>
      <ResizableHandle
        aria-label={t('Resize right panel')}
        disabled={!split}
        aria-hidden={!split}
        onPointerDown={(event) => {
          // Keep drag events in this document when the pointer crosses a PDF/HTML iframe.
          if (split && event.button === 0) event.currentTarget.setPointerCapture(event.pointerId)
        }}
        className={
          split
            ? 'z-20 bg-border-200 after:w-5 before:top-0 before:h-full before:translate-y-0 before:bg-text-200 hover:before:opacity-100 focus-visible:before:opacity-100 data-[separator=hover]:before:opacity-100 data-[separator=active]:before:opacity-100'
            : 'hidden'
        }
      />
      <ResizablePanel
        id={provenanceId}
        defaultSize="40%"
        minSize={split ? '25%' : mode === 'provenance' ? '100%' : '0%'}
        maxSize={mode === 'content' ? '0%' : '100%'}
        aria-hidden={mode === 'content' || undefined}
        inert={mode === 'content' || undefined}
      >
        {provenance}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
