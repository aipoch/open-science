import { X } from 'lucide-react'
import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import type { ClaudeInstallSource } from '../../../../shared/settings'
import { AgentInstallSourceMenu, type AgentInstallSourceMenuProps } from './AgentInstallSourceMenu'

type RepairFrameworkDialogProps = Omit<
  AgentInstallSourceMenuProps,
  'label' | 'name' | 'onInstall'
> & {
  name: string | null
  onCancel: () => void
  onRepair: (source: ClaudeInstallSource) => void
}

// Clicking a broken card explains why it cannot be selected, then exposes the exact same repair
// sources as the card action. Selecting a source closes the explanation before installation starts.
const RepairFrameworkDialog = ({
  name,
  sources,
  installing,
  disabled,
  npmAvailable,
  blockedInstallSources,
  onCancel,
  onRepair
}: RepairFrameworkDialogProps): React.JSX.Element => (
  <AlertDialog.Root
    open={Boolean(name)}
    onOpenChange={(open) => {
      if (!open) onCancel()
    }}
  >
    <AlertDialog.Portal>
      <AlertDialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
      <AlertDialog.Content
        className={dialogPanelClassName('z-[60] w-[min(440px,calc(100vw-2rem))] p-0')}
      >
        <div className={dialogHeaderClassName}>
          <div className="min-w-0">
            <AlertDialog.Title className={dialogTitleClassName}>
              {name} needs repair
            </AlertDialog.Title>
          </div>
          <AlertDialog.Cancel asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              className={dialogCloseButtonClassName}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </AlertDialog.Cancel>
        </div>

        <div className={dialogBodyClassName}>
          <AlertDialog.Description className={dialogDescriptionClassName}>
            Repair this agent before selecting it.
          </AlertDialog.Description>
        </div>

        <div className={dialogFooterClassName}>
          <AlertDialog.Cancel asChild>
            <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
          {name ? (
            <AgentInstallSourceMenu
              name={name}
              label="Repair"
              sources={sources}
              installing={installing}
              disabled={disabled}
              npmAvailable={npmAvailable}
              blockedInstallSources={blockedInstallSources}
              buttonSize="default"
              onInstall={onRepair}
            />
          ) : null}
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
)

export { RepairFrameworkDialog }
