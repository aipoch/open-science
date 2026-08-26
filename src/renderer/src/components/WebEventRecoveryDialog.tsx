import { AlertDialog } from 'radix-ui'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { WebEventConnectionPhase } from '../../../shared/web-event-connection'
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

type WebEventRecoveryDialogProps = {
  active: boolean
  phase: WebEventConnectionPhase
}

const WebEventRecoveryDialog = ({
  active,
  phase
}: WebEventRecoveryDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const reloadRequired = phase === 'reload-required'
  const reloadAvailable = phase === 'reconnecting' || reloadRequired
  const title =
    phase === 'connecting'
      ? t('Connecting to Open Science')
      : phase === 'reconnecting'
        ? t('Reconnecting to Open Science')
        : phase === 'replaying'
          ? t('Restoring missed updates')
          : t('Reload required')
  const description = reloadRequired
    ? t(
        'Open Science could not restore a complete, current view. Reload this page to reconnect safely.'
      )
    : t(
        'Controls are paused while Open Science restores updates that may have arrived during the interruption.'
      )

  return (
    <AlertDialog.Root open={active}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              <span className="inline-flex items-center gap-2">
                <RefreshCw
                  aria-hidden="true"
                  className={reloadRequired ? 'size-4' : 'size-4 animate-spin'}
                />
                {title}
              </span>
            </AlertDialog.Title>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {description}
            </AlertDialog.Description>
          </div>
          {reloadAvailable ? (
            <div className={dialogFooterClassName}>
              <Button type="button" onClick={() => window.location.reload()}>
                <RefreshCw aria-hidden="true" />
                {t('Reload', { context: 'window', ns: 'common' })}
              </Button>
            </div>
          ) : null}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { WebEventRecoveryDialog }
