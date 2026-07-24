import { FocusScope } from '@radix-ui/react-focus-scope'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'

import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { PreviewFileSurface } from './PreviewFileSurface'

type FilePreviewDialogProps = {
  item: PreviewFileItem | undefined
  onClose: () => void
}

const STREAMDOWN_FULLSCREEN_SELECTOR =
  '[data-streamdown="table-fullscreen"], body > div.fixed.inset-0.z-50.flex.items-center.justify-center[role="button"]:not([data-streamdown])'

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
const FilePreviewDialog = ({ item, onClose }: FilePreviewDialogProps): React.JSX.Element | null => {
  const dialogItem = useRetainedDialogValue(item)
  const open = Boolean(item)
  const [hasNestedFullscreen, setHasNestedFullscreen] = useState(hasStreamdownFullscreen)
  const isBackgroundIsolatedRef = useRef(false)

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
        if (!nextOpen) onClose()
      }}
    >
      <Dialog.Portal>
        <div
          aria-hidden="true"
          data-state={open ? 'open' : 'closed'}
          className={`${dialogOverlayClassName} z-[60]`}
        />
        <Dialog.Content
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
            {dialogItem ? `Preview ${dialogItem.title}` : 'File preview'}
          </Dialog.Title>
          <FocusScope asChild loop trapped={!(open && hasNestedFullscreen)}>
            <div className="flex size-full min-h-0 min-w-0">
              {dialogItem ? (
                <PreviewFileSurface item={dialogItem} onClose={onClose} tooltipClassName="z-[70]" />
              ) : null}
            </div>
          </FocusScope>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { FilePreviewDialog }
