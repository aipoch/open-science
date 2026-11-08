import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../shared/web-caller-location'
import type { ManualStagedCleanup } from '../../../shared/compute'
import * as AlertDialog from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { InlineNotice } from '@/components/ui/inline-notice'

type Props = {
  scope: { jobId: string; providerId: string; projectId: string; sessionId: string }
  resource: ManualStagedCleanup
  disabled?: boolean
  onCleaned: () => void
}

export function StagedResourceCleanupButton({
  scope,
  resource,
  disabled,
  onCleaned
}: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)

  if (
    document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) === 'remote' ||
    typeof window.api?.compute?.jobsSetRemoteCleanup !== 'function'
  )
    return null

  const clean = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setFailed(false)
    try {
      await window.api.compute.jobsSetRemoteCleanup({
        ...scope,
        disposition: 'cleaned',
        manualStagedCleanup: true
      })
    } catch {
      setFailed(true)
      return
    } finally {
      pending.current = false
      setBusy(false)
    }
    setOpen(false)
    onCleaned()
  }

  const rows =
    resource.kind === 'hugging_face_jobs'
      ? [
          [t('Bucket'), resource.bucket],
          [t('Job prefix'), resource.prefix]
        ]
      : [
          [t('Environment'), resource.environmentName],
          [t('Volume ID'), resource.volumeId]
        ]

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (pending.current) return
        setOpen(next)
        setFailed(false)
      }}
    >
      <AlertDialog.Trigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={disabled}>
          {t('Clean up staged resources')}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('Delete staged resources?')}
            </AlertDialog.Title>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description className="text-sm text-muted-foreground">
              {resource.kind === 'hugging_face_jobs'
                ? t('Delete the staged files under this job prefix.')
                : t('Delete this job’s staged volume.')}
            </AlertDialog.Description>
            <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="break-all font-mono text-xs">{value}</dd>
                </div>
              ))}
            </dl>
            {failed && (
              <InlineNotice className="mt-4" level="error" role="alert">
                {t('Could not update remote cleanup for this Compute Job.')}
              </InlineNotice>
            )}
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
              disabled={busy}
              onClick={() => void clean()}
            >
              {busy ? t('Deleting…') : t('Delete')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
