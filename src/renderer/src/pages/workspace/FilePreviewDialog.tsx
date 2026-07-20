import { Dialog } from 'radix-ui'

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
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        {/* Keep the modal large enough for document renderers while leaving workspace context visible. */}
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[60] flex h-[90vh] w-[90vw] max-w-none -translate-x-1/2 -translate-y-1/2 overflow-hidden overscroll-contain rounded-md bg-bg-000 text-text-000 shadow-dialog"
        >
          <Dialog.Title className="sr-only">Preview {item.title}</Dialog.Title>
          <PreviewFileSurface item={item} onClose={onClose} tooltipClassName="z-[70]" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { FilePreviewDialog }
