import { Dialog } from 'radix-ui'

import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { PreviewFileSurface } from './PreviewFileSurface'

type FilePreviewDialogProps = {
  item: PreviewFileItem | undefined
  onClose: () => void
}

// The dialog is deliberately transient: Files tiles and panel previews can open it without
// creating or removing a preview-workbench item.
const FilePreviewDialog = ({ item, onClose }: FilePreviewDialogProps): React.JSX.Element | null => {
  if (!item) return null

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        {/* Keep the modal large enough for document renderers while leaving workspace context visible. */}
        <Dialog.Content
          aria-describedby={undefined}
          onInteractOutside={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'z-[60] flex h-[90vh] w-[90vw] max-w-none overflow-hidden overscroll-contain p-0'
          )}
        >
          <Dialog.Title className="sr-only">Preview {item.title}</Dialog.Title>
          <PreviewFileSurface item={item} onClose={onClose} tooltipClassName="z-[70]" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { FilePreviewDialog }
