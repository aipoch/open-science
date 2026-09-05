import { FocusScope } from '@radix-ui/react-focus-scope'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from 'radix-ui'

import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { STREAMDOWN_FULLSCREEN_SELECTOR } from '@/components/streamdown/dom-selectors'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { dialogPreviewGuardScope } from '@/stores/preview-leave-guard'

import { PreviewFileSurface, type PreviewFileSurfaceHandle } from './PreviewFileSurface'
import type { PreviewInteractionPort } from './previews/preview-types'

type FilePreviewDialogProps = PreviewInteractionPort & {
  item: PreviewFileItem | undefined
  onClose: (skipGuard?: boolean) => void
  onItemChange?: (item: PreviewFileItem, skipGuard?: boolean) => void
  onPdfContextError?: (message: string | null) => void
}

const hasStreamdownFullscreen = (): boolean =>
  Boolean(document.querySelector(STREAMDOWN_FULLSCREEN_SELECTOR))

let backgroundIsolationCount = 0
let previousRootAriaHidden: string | null = null
let previousRootInert = false

const setBackgroundIsolation = (isolated: boolean): void => {
  const appRoot = document.getElementById('root')
  if (!appRoot) return

  if (isolated) {
    if (backgroundIsolationCount === 0) {
      previousRootAriaHidden = appRoot.getAttribute('aria-hidden')
      previousRootInert = Boolean(appRoot.inert)
      appRoot.setAttribute('aria-hidden', 'true')
      appRoot.inert = true
    }
    backgroundIsolationCount += 1
    return
  }

  backgroundIsolationCount = Math.max(0, backgroundIsolationCount - 1)
  if (backgroundIsolationCount > 0) return
  if (previousRootAriaHidden === null) appRoot.removeAttribute('aria-hidden')
  else appRoot.setAttribute('aria-hidden', previousRootAriaHidden)
  appRoot.inert = previousRootInert
}

// The dialog is deliberately transient: Files tiles and panel previews can open it without
// creating or removing a preview-workbench item.
const FilePreviewDialog = ({
  item,
  onClose,
  onItemChange,
  onPdfContextError,
  ...annotationPort
}: FilePreviewDialogProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const dialogItem = useRetainedDialogValue(item)
  const open = Boolean(item)
  const [hasNestedFullscreen, setHasNestedFullscreen] = useState(hasStreamdownFullscreen)
  const isBackgroundIsolatedRef = useRef(false)
  const previewSurfaceRef = useRef<PreviewFileSurfaceHandle | null>(null)
  const requestClose = useCallback(
    (checkGuard = true): void => {
      if (checkGuard && previewSurfaceRef.current) {
        previewSurfaceRef.current.requestLeave(() => onClose(true))
        return
      }
      onClose(true)
    },
    [onClose]
  )

  const acquireBackgroundIsolation = useCallback((): void => {
    if (isBackgroundIsolatedRef.current) return
    setBackgroundIsolation(true)
    isBackgroundIsolatedRef.current = true
  }, [])

  const releaseBackgroundIsolation = useCallback((): void => {
    if (!isBackgroundIsolatedRef.current) return
    setBackgroundIsolation(false)
    isBackgroundIsolatedRef.current = false
  }, [])

  useEffect(() => {
    const observer = new MutationObserver(() => setHasNestedFullscreen(hasStreamdownFullscreen()))
    observer.observe(document.body, { childList: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (open) acquireBackgroundIsolation()
    else if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      releaseBackgroundIsolation()
    }
  }, [acquireBackgroundIsolation, open, releaseBackgroundIsolation])

  useEffect(() => releaseBackgroundIsolation, [releaseBackgroundIsolation])

  return (
    <Dialog.Root
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose(true)
      }}
    >
      <Dialog.Portal>
        <div
          aria-hidden="true"
          data-state={open ? 'open' : 'closed'}
          className={`${dialogOverlayClassName} z-[60]`}
        />
        <Dialog.Content
          data-slot="file-preview-dialog"
          aria-describedby={undefined}
          aria-modal="true"
          onInteractOutside={(event) => event.preventDefault()}
          onAnimationEnd={(event) => {
            if (!open && event.target === event.currentTarget) releaseBackgroundIsolation()
          }}
          className={dialogPanelClassName(
            'z-[60] flex h-[90vh] w-[90vw] max-w-none overflow-hidden overscroll-contain p-0'
          )}
        >
          <Dialog.Title className="sr-only">
            {dialogItem ? t('Preview {{title}}', { title: dialogItem.title }) : t('File preview')}
          </Dialog.Title>
          <FocusScope asChild loop trapped={!(open && hasNestedFullscreen)}>
            <div className="flex size-full min-h-0 min-w-0">
              {dialogItem ? (
                <PreviewFileSurface
                  ref={previewSurfaceRef}
                  item={dialogItem}
                  onClose={() => requestClose(false)}
                  {...(onItemChange
                    ? { onItemChange: (nextItem: PreviewFileItem) => onItemChange(nextItem, true) }
                    : {})}
                  provenanceEntry="trailing"
                  // The modal overlays the conversation panel, so a View in context navigation must
                  // also close the dialog for the switched session to become visible.
                  onViewInContextNavigate={onClose}
                  onPdfContextError={onPdfContextError}
                  tooltipClassName="z-[70]"
                  actionMenuContentClassName="z-[70]"
                  leaveGuardScope={dialogPreviewGuardScope(dialogItem.projectId, dialogItem.id)}
                  retryResolutionEnabled={open}
                  {...annotationPort}
                />
              ) : null}
            </div>
          </FocusScope>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { FilePreviewDialog }
