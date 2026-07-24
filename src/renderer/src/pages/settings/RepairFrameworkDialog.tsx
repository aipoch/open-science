import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
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
      <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
      <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-6 text-foreground shadow-menu">
        <AlertDialog.Title className="text-base font-semibold text-foreground">
          {name} needs repair
        </AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Repair this agent before selecting it.
        </AlertDialog.Description>
        <div className="mt-6 flex justify-end gap-2">
          <AlertDialog.Cancel asChild>
            <Button type="button" variant="outline">
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
              onInstall={onRepair}
            />
          ) : null}
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
)

export { RepairFrameworkDialog }
