import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertDialog } from 'radix-ui'

import type { ComputeHost } from '../../../../shared/compute'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useComputeStore } from '@/stores/compute-store'

type ComputeHostRemovalDialogProps = {
  host: ComputeHost
  onRemoved: () => void
}

export function ComputeHostRemovalDialog({
  host,
  onRemoved
}: ComputeHostRemovalDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const deleteHost = useComputeStore((state) => state.deleteHost)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [blocked, setBlocked] = useState<boolean | undefined>(undefined)

  const openConfirmation = (): void => {
    setOpen(true)
    setError(undefined)
    setBlocked(undefined)
    void window.api.compute
      .deletionStatus({ providerId: host.providerId })
      .then(({ blockedByJobs }) => setBlocked(blockedByJobs))
      .catch(() => setError(t('Could not check whether this Host can be removed.')))
  }

  const removeHost = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await deleteHost(host.providerId)
      setOpen(false)
      onRemoved()
    } catch {
      setError(t('Could not remove this Compute Host.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          asChild
          onFocus={(event) => {
            if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
          }}
        >
          <AlertDialog.Trigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={openConfirmation}
              aria-label={t('Remove {{name}}', { name: host.displayName })}
              className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </AlertDialog.Trigger>
        </TooltipTrigger>
        <TooltipContent>{t('Remove host')}</TooltipContent>
      </Tooltip>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(460px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('Remove Compute Host?')}
            </AlertDialog.Title>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {host.authentication?.mode === 'password'
                ? t(
                    'The local Compute Host and encrypted password will be deleted. The remote SSH account is unchanged, and the password cannot be recovered.'
                  )
                : t('The local Compute Host will be deleted. The remote SSH account is unchanged.')}
            </AlertDialog.Description>
            {blocked ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {t(
                  'This Host cannot be removed while Compute Jobs are active or still need harvesting or remote cleanup.'
                )}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" disabled={busy}>
                {t('Cancel')}
              </Button>
            </AlertDialog.Cancel>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || blocked !== false}
              onClick={() => void removeHost()}
            >
              {busy ? t('Removing…') : t('Remove Host')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
