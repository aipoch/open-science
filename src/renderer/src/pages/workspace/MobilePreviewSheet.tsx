import { useEffect, useRef } from 'react'
import { FocusScope } from '@radix-ui/react-focus-scope'
import { X } from 'lucide-react'
import { useChildLayerDismissalGuard } from '@/components/ui/use-child-layer-dismissal-guard'
import { useTranslation } from 'react-i18next'

import { PreviewPanelSurface } from './PreviewPanel'
import type { RestoredPlanResponder } from './session-plan/SessionPlanSurfaces'
import type { PreviewInteractionPort } from './previews/preview-types'

type MobilePreviewSheetProps = PreviewInteractionPort & {
  isMobile?: boolean
  open: boolean
  onClose: () => void
  restoredPlanResponder?: RestoredPlanResponder
  onPdfContextError?: (message: string | null) => void
}

// Mobile workbench presentation: generated files, code, and notebooks keep the desktop tab model,
// but rise from the bottom so the conversation remains the primary screen.
const MobilePreviewSheet = ({
  isMobile = true,
  open,
  onClose,
  restoredPlanResponder,
  onPdfContextError,
  ...annotationPort
}: MobilePreviewSheetProps): React.JSX.Element => {
  const { t } = useTranslation()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const modalOpen = isMobile && open
  const { setContentRef, onInteractOutside } = useChildLayerDismissalGuard(surfaceRef)

  useEffect(() => {
    if (!modalOpen) return
    const surface = surfaceRef.current
    if (!surface) return
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // The sheet stays inline to preserve the editor. Isolate siblings along its ancestor path,
    // rather than making the app root (which now contains the sheet) inert.
    const isolated: { element: HTMLElement; inert: boolean; hidden: string | null }[] = []
    for (
      let child: HTMLElement = surface;
      child.parentElement && child.parentElement !== document.body;
      child = child.parentElement
    ) {
      for (const sibling of child.parentElement.children) {
        if (
          sibling === child ||
          !(sibling instanceof HTMLElement) ||
          sibling.hasAttribute('data-preview-sheet-overlay')
        )
          continue
        isolated.push({
          element: sibling,
          inert: sibling.inert,
          hidden: sibling.getAttribute('aria-hidden')
        })
        sibling.setAttribute('inert', '')
        sibling.setAttribute('aria-hidden', 'true')
      }
    }
    if (!surface.contains(previousFocus)) surface.focus()
    return () => {
      for (const { element, inert, hidden } of isolated) {
        if (inert) element.setAttribute('inert', '')
        else element.removeAttribute('inert')
        if (hidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', hidden)
      }
      document.body.style.overflow = previousOverflow
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        surface.hidden &&
        (surface.contains(document.activeElement) || document.activeElement === document.body) &&
        !previousFocus.closest('[inert], [hidden]')
      )
        previousFocus.focus()
    }
  }, [modalOpen])

  return (
    <>
      {modalOpen ? (
        <div
          data-preview-sheet-overlay
          aria-hidden="true"
          className="fixed inset-0 z-50 bg-black/45"
          onPointerDown={(event) => {
            onInteractOutside({
              detail: { originalEvent: event.nativeEvent },
              preventDefault: () => event.preventDefault()
            })
            if (!event.defaultPrevented) onClose()
          }}
        />
      ) : null}
      <FocusScope
        asChild
        loop={modalOpen}
        trapped={modalOpen}
        onMountAutoFocus={(event) => event.preventDefault()}
        onUnmountAutoFocus={(event) => event.preventDefault()}
      >
        <div
          ref={setContentRef}
          tabIndex={-1}
          role={modalOpen ? 'dialog' : undefined}
          aria-modal={modalOpen || undefined}
          aria-label={isMobile ? t('Preview') : undefined}
          aria-description={
            isMobile ? t('Open files, generated artifacts, code, and notebooks.') : undefined
          }
          hidden={isMobile && !open}
          data-testid={isMobile && open ? 'mobile-preview-sheet' : undefined}
          onKeyDown={(event) => {
            if (modalOpen && event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault()
              event.stopPropagation()
              onClose()
            }
          }}
          className={
            isMobile
              ? 'fixed inset-x-0 bottom-0 z-[60] h-[min(82dvh,760px)] overflow-hidden rounded-t-2xl border border-b-0 border-border-200 bg-bg-10 pb-[env(safe-area-inset-bottom)] text-text-000 shadow-dialog outline-none'
              : 'h-full min-h-0 outline-none'
          }
        >
          <div className="flex h-full min-h-0 flex-col">
            <div
              hidden={!isMobile}
              className="shrink-0 items-center gap-3 border-b border-border-200 px-4 py-2.5"
              style={isMobile ? { display: 'flex' } : undefined}
            >
              <div className="h-1 w-10 rounded-full bg-border-300 md:hidden" aria-hidden="true" />
              <h2 className="min-w-0 flex-1 text-sm font-semibold">{t('Preview')}</h2>
              <button
                type="button"
                className="grid size-8 shrink-0 place-items-center rounded-lg text-text-300 hover:bg-bg-200 hover:text-text-000"
                aria-label={t('Close preview')}
                onClick={onClose}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <PreviewPanelSurface
              className="min-h-0 flex-1"
              restoredPlanResponder={restoredPlanResponder}
              {...annotationPort}
              onPdfContextError={onPdfContextError}
            />
          </div>
        </div>
      </FocusScope>
    </>
  )
}

export { MobilePreviewSheet }
