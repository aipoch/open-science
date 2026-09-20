import type { ReactNode } from 'react'
import * as Dialog from '@/components/ui/dialog'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'

export function LiteratureImportDialogFrame({
  title,
  description,
  busy,
  onClose,
  children,
  footer
}: {
  title: string
  description: string
  busy: boolean
  onClose: () => void
  children: ReactNode
  footer: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[calc(100dvh-2rem)] w-[min(740px,calc(100vw-2rem))] flex-col p-0'
          )}
        >
          <div className={cn(dialogHeaderClassName, 'shrink-0')}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>{title}</Dialog.Title>
              <Dialog.Description
                className={cn(dialogDescriptionClassName, '[overflow-wrap:anywhere]')}
              >
                {description}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={dialogCloseButtonClassName}
                disabled={busy}
                aria-label={t('Close')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          {children}
          {footer}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
