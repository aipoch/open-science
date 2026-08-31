import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'

import { PreviewPanelSurface } from './PreviewPanel'
import type { RestoredPlanResponder } from './session-plan/SessionPlanSurfaces'
import type { PreviewInteractionPort } from './previews/preview-types'

type MobilePreviewSheetProps = PreviewInteractionPort & {
  open: boolean
  onClose: () => void
  restoredPlanResponder?: RestoredPlanResponder
  onPdfContextError?: (message: string | null) => void
}

// Mobile workbench presentation: generated files, code, and notebooks keep the desktop tab model,
// but rise from the bottom so the conversation remains the primary screen.
const MobilePreviewSheet = ({
  open,
  onClose,
  restoredPlanResponder,
  onPdfContextError,
  ...annotationPort
}: MobilePreviewSheetProps): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none" />
        <Dialog.Content
          data-testid="mobile-preview-sheet"
          className="fixed inset-x-0 bottom-0 z-[60] flex h-[min(82dvh,760px)] flex-col overflow-hidden rounded-t-2xl border border-b-0 border-border-200 bg-bg-10 pb-[env(safe-area-inset-bottom)] text-text-000 shadow-dialog outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none"
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-border-200 px-4 py-2.5">
            <div className="h-1 w-10 rounded-full bg-border-300 md:hidden" aria-hidden="true" />
            <Dialog.Title className="min-w-0 flex-1 text-sm font-semibold">
              {t('Preview')}
            </Dialog.Title>
            <Dialog.Description className="sr-only">
              {t('Open files, generated artifacts, code, and notebooks.')}
            </Dialog.Description>
            <Dialog.Close asChild>
              <button
                type="button"
                className="grid size-8 shrink-0 place-items-center rounded-lg text-text-300 hover:bg-bg-200 hover:text-text-000"
                aria-label={t('Close preview')}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <PreviewPanelSurface
            className="min-h-0 flex-1"
            restoredPlanResponder={restoredPlanResponder}
            {...annotationPort}
            onPdfContextError={onPdfContextError}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { MobilePreviewSheet }
