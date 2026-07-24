import { Dialog } from 'radix-ui'

import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { cn } from '@/lib/utils'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { PreviewFileSurface } from './PreviewFileSurface'

type FilePreviewDialogProps = {
  item: PreviewFileItem | undefined
  onClose: () => void
}

// The dialog is deliberately transient: Files tiles and panel previews can open it without
// creating or removing a preview-workbench item.
const FilePreviewDialog = ({ item, onClose }: FilePreviewDialogProps): React.JSX.Element | null => {
  const dialogItem = useRetainedDialogValue(item)

  return (
    <Dialog.Root
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {dialogItem ? (
        <Dialog.Portal>
          <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
          {/* Keep the modal large enough for document renderers while leaving workspace context visible. */}
          <Dialog.Content
            aria-describedby={undefined}
            onInteractOutside={(event) => event.preventDefault()}
            className={dialogPanelClassName(
              'z-[60] flex h-[90vh] w-[90vw] max-w-none overflow-hidden overscroll-contain p-0'
            )}
          >
            <Dialog.Title className="sr-only">Preview {dialogItem.title}</Dialog.Title>
            <PreviewFileSurface item={dialogItem} onClose={onClose} tooltipClassName="z-[70]" />
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  )
}

export { FilePreviewDialog }
